/**
 * commits reads the target branch's history once and serves it to every
 * consumer of it.
 *
 * A projection runs release-please twice over the same branch — once with the
 * synthetic commit and once without — and the second walk reads the same
 * commits the first one did, from the same API, in the same order. On a
 * repository where the walk is cheap that is a few seconds spent twice. On one
 * where it is not, it is the whole cost paid twice: a measured 103-second walk
 * on `jmcvetta/career` became a 183-second step (issue #54).
 *
 * So the walk is memoized, and the cache is keyed on the target branch alone.
 * Keying it on the whole option set instead looked safer and was not: a pass
 * asks for the branch's history more than once and with different options each
 * time. `Manifest.fromConfig` resolves the last release first, asking
 * `{maxResults: 250}`, and `buildPullRequests` then asks `{maxResults: 500,
 * backfillFiles: true, batchSize: 100}`. An option-keyed cache answers the
 * first question and delegates the second to a fresh walk, in both passes —
 * every page of the real walk fetched twice. This repository releases in
 * plain mode, so it paid that on every pull request it has ever opened, and
 * the suite reported one walk throughout: the test that drove a real
 * `Manifest` drove manifest mode, where `fromConfig` is never called, and the
 * test that drove this file directly asserted the second walk as the intended
 * contract (issue #65).
 *
 * Two things this must not do, both of which look right and are not:
 *
 * - **Delegate with `yield*`.** release-please stops the walk by breaking out
 *   of a `for await`, which calls `return()` on the generator it is reading —
 *   and `yield*` forwards that to the upstream generator, closing it for good.
 *   The first pass would then leave nothing for the second to continue from.
 *   Pulling one commit at a time keeps the upstream generator merely
 *   suspended.
 * - **Replay a cached commit to a consumer that would not have seen it.** The
 *   caps are applied at replay instead, in whole pages, because that is where
 *   release-please applies them. See `mergeCommitIterator` below.
 */

import type { Commit, GitHub } from "release-please";

/**
 * UPSTREAM_BATCH_SIZE is the page size release-please walks with when the
 * caller names none — `mergeCommitsGraphQL`'s `first: $num` default, and what
 * its `Manifest` falls back to for a batch size it discards.
 *
 * It is spelled here because the replay has to stop where the real walk would
 * have, and where that is depends on the page size the consumer asked for.
 */
export const UPSTREAM_BATCH_SIZE = 10;

/**
 * walkPageSize is how many commits one page of a walk with this batch size
 * carries: what the replay stops on, and what the shared read fetches with.
 *
 * A usable size is a whole number of commits, because that is what upstream's
 * query takes — `$num` is an `Int!`. Anything else is release-please's own
 * default, which is either what that walk pages at or the closest thing to it
 * there is: its `Manifest` resolves a batch size with `||`, so a zero reaches
 * `mergeCommitIterator` as ten, while a string or a fraction is passed on for
 * GitHub to reject, and a run that cannot happen has no page size to
 * describe.
 */
export function walkPageSize(batchSize: unknown): number {
  const whole = typeof batchSize === "number" && Number.isInteger(batchSize);
  return whole && batchSize >= 1 ? batchSize : UPSTREAM_BATCH_SIZE;
}

/**
 * CommitFiles answers a commit's file list from somewhere cheaper than the
 * REST API, and undefined for a commit it does not know.
 *
 * release-please backfills the file list one serial request per commit for
 * every commit GitHub does not associate with a merged pull request — about
 * 80% of them on a branch that carries direct pushes. See `commitFileIndex`
 * in git.ts, which answers the same question from the local checkout.
 */
export type CommitFiles = (sha: string) => string[] | undefined;

/** CommitSourceOptions are what a source may be given beyond the client. */
export interface CommitSourceOptions {
  /** files serves commit file lists, when something cheaper than the API can. */
  files?: CommitFiles;
  /**
   * batchSize is how many commits one page of the shared walk carries.
   *
   * It is the size the projection's own release-please run walks with, so the
   * shared walk pages as coarsely as the consumer that matters. Left unset it
   * is release-please's default of 10, which is 25 serial pages to reach a
   * release pull request 250 commits back.
   */
  batchSize?: number;
}

/**
 * commitSource wraps a release-please `GitHub` so the target branch's history
 * is read once and its file lists come from the cheapest source available.
 *
 * The wrap is an object whose prototype is the client, the same arrangement
 * pr-view.ts uses: inherited methods keep working and the overridden ones are
 * own properties shadowing them. The upstream iterator is created with the
 * wrapper as its receiver, so the file-list override is the one release-please
 * reaches for while backfilling.
 *
 * A client with no `mergeCommitIterator` is returned untouched. That is the
 * seam having moved, which is pr-view.ts's error to raise — it is the one that
 * can explain what breaks.
 */
export function commitSource(
  github: GitHub,
  options: CommitSourceOptions = {},
): GitHub {
  if (typeof github.mergeCommitIterator !== "function") return github;

  const source: GitHub = Object.create(github);
  const serve = options.files;
  if (serve) {
    source.getCommitFiles = async function (sha: string): Promise<string[]> {
      return serve(sha) ?? (await github.getCommitFiles(sha));
    };
  }

  /**
   * The options the one shared walk is started with.
   *
   * `backfillFiles` is on regardless of what a consumer asks for, because a
   * commit fetched without it cannot be upgraded afterwards: upstream reads
   * `pageInfo.hasNextPage` on the pull request's file list to decide whether a
   * REST call is needed, and the commit it yields does not carry that flag.
   * So the walk that fills the cache is the backfilling one, and a consumer
   * that asked for no file lists is handed commits carrying them anyway,
   * which it does not read.
   *
   * That is not free, and the release search is the consumer it is not free
   * for. It can reach *further* than the pull request build, which stops at
   * the release boundary, and upstream backfills a whole page before yielding
   * its first commit — so replaying 250 commits to it backfills the 300 the
   * shared walk fetched, where release-please would have walked those 250 in
   * pages of ten with no file lists at all. Where the checkout is deep the
   * index in git.ts answers every one of them; where it is shallow they are
   * REST calls, against the round trips per page the shared walk saves.
   *
   * The page size is one for all of them, and upstream counts a merge
   * commit's pull requests per page — which decides whether a commit's file
   * list is its pull request's or a backfill of its own diff, and, for a
   * commit GitHub associates with more than one pull request, which of them
   * the commit carries. The file lists are safe: the consumer that reads them
   * is handed the page size its own run uses, and the release search reads no
   * files. Which pull request a commit carries is not proved safe, only
   * narrow — a coarser page can lose the sole-commit match, and the release
   * search reads the pull request's branch and title — but it takes a commit
   * that GitHub associates with a second pull request, sharing its page with
   * another commit of the first, at a boundary the finer pages did not have.
   *
   * `maxResults` is deliberately absent. A cap here could not be any
   * consumer's own: release-please stops between pages rather than between
   * commits, so a consumer capped at 40 in pages of 25 reads 50, and a shared
   * walk stopped at 40 would starve it of ten commits — silently, since a
   * short history is what a branch with no more commits looks like. Nothing
   * needs to bound it: the walk is pulled one commit at a time, so a page
   * nobody reads is a page never fetched.
   */
  const walkOptions: Parameters<GitHub["mergeCommitIterator"]>[1] = {
    backfillFiles: true,
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
  };

  // The branch the cache holds the history of. A walk over another one is a
  // different history and is delegated rather than answered wrongly.
  let branch: string | undefined;
  const walked: Commit[] = [];
  let upstream: AsyncGenerator<Commit, void, unknown> | undefined;
  let exhausted = false;
  // The error that ended the shared walk, if one did. A generator that throws
  // is finished, so a later consumer asking for the commit after the failure
  // would be told the branch simply ends there. It is handed the error
  // instead: this cache spans consumers now, and a walk cut short by a
  // transient failure would otherwise be a projection quietly computed from
  // half a history.
  let failure: { error: unknown } | undefined;
  // One pull at a time. The passes are sequential today; a shared generator
  // read from two places at once would interleave, and that is not a failure
  // anyone would enjoy diagnosing.
  let queue: Promise<unknown> = Promise.resolve();

  /** at returns the nth commit of the walk, pulling upstream when the cache
   * does not reach it and undefined once the history runs out. */
  const at = (n: number): Promise<Commit | undefined> => {
    const pull = queue.then(async () => {
      if (n < walked.length) return walked[n];
      if (failure) throw failure.error;
      if (exhausted || !upstream) return undefined;
      let next;
      try {
        next = await upstream.next();
      } catch (error) {
        failure = { error };
        throw error;
      }
      if (next.done) {
        exhausted = true;
        return undefined;
      }
      walked.push(next.value);
      return next.value;
    });
    // A rejected pull must not poison the chain, which is for ordering
    // alone. What the failure does end is the walk, above -- a consumer is
    // handed the error rather than a history that stops at it.
    queue = pull.then(
      () => undefined,
      () => undefined,
    );
    return pull;
  };

  source.mergeCommitIterator = async function* (
    targetBranch: string,
    iteratorOptions?: Parameters<GitHub["mergeCommitIterator"]>[1],
  ): AsyncGenerator<Commit> {
    if (branch === undefined) {
      branch = targetBranch;
      upstream = github.mergeCommitIterator.call(
        source,
        targetBranch,
        walkOptions,
      );
    } else if (targetBranch !== branch) {
      yield* github.mergeCommitIterator.call(
        source,
        targetBranch,
        iteratorOptions,
      );
      return;
    }

    // release-please checks its cap between pages rather than between
    // commits, so a walk overshoots to the next whole page: 250 at a batch of
    // 10 yields 250, and 250 at a batch of 100 yields 300. The difference is
    // not cosmetic — `latestReleaseVersion` accepts or rejects a release by
    // whether its sha is among the ones the walk handed it — so the replay
    // stops where the real walk would have, at the page size this consumer
    // asked for rather than the one the shared walk fetches with.
    //
    // The page size is this consumer's, resolved as release-please would
    // resolve it: see walkPageSize.
    const maxResults = iteratorOptions?.maxResults ?? Number.MAX_SAFE_INTEGER;
    const page = walkPageSize(iteratorOptions?.batchSize);
    // The outer loop counts pages rather than the commits the inner one
    // yielded, so a page size that fits nothing ends the walk instead of
    // spinning on it. `walkPageSize` is what keeps that from happening at
    // all; this is what keeps the mistake reportable, since a loop that
    // neither advances nor awaits cannot be timed out by anything.
    for (let start = 0; start < maxResults; start += page) {
      for (let i = 0; i < page; i++) {
        const commit = await at(start + i);
        if (!commit) return;
        yield commit;
      }
    }
  } as GitHub["mergeCommitIterator"];

  return source;
}
