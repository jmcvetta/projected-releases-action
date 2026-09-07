/**
 * history reads the repository once and serves it to every walk a projection
 * makes: the target branch's commits, the releases, and the tags.
 *
 * A projection runs release-please twice over the same branch — once with the
 * synthetic commit and once without — and the second run asks the same
 * questions the first one did, of the same API, in the same order. On a
 * repository where the commit walk is cheap that is a few seconds spent
 * twice. On one where it is not, it is the whole cost paid twice: a measured
 * 103-second walk on `jmcvetta/career` became a 183-second step (issue #54).
 *
 * The releases are read more times still, because each pass asks for them
 * twice. `Manifest.fromConfig` resolves the last release through
 * `latestReleaseVersion`, and `buildPullRequests` walks them again to resolve
 * every component's — one walk, not one per component — so a plain-mode
 * projection listed the releases four times, with identical pages, before
 * this cached them (issue #66). The tags are the fallback each of those
 * reaches when a release does not resolve, so a repository whose releases all
 * resolve makes no tag walk at all, and one whose releases do not makes up to
 * one per release walk — the two callers fall through independently.
 *
 * The two release callers do not agree on how many they want:
 * `latestReleaseVersion` asks for all of them and `buildPullRequests` caps
 * the walk at the release search depth. So the release walk is started
 * uncapped and each consumer's cap is applied to what it is handed, which
 * reads no more pages than upstream would have read for the deepest caller
 * that actually ran. A capped consumer leaves the shared iterator suspended
 * at its cap rather than reading past it — one page fewer, in fact, than
 * upstream's own capped walk fetches when the cap lands on a page boundary.
 *
 * So every walk is memoized. A cache is filled by the first consumer as it is
 * consumed, and a later one replays it and continues the same upstream
 * iterator where the first one stopped — never a fresh one, which would ask
 * for the same pages again. Releases and tags get one cache per distinct set
 * of options; the branch's commits get one, whatever is asked of them, with
 * each consumer's cap applied to what it is handed (issue #65).
 *
 * Three things this must not do, each of which looks right and is not:
 *
 * - **Delegate to the upstream iterator with `yield*`.** release-please stops
 *   a walk by breaking out of a `for await`, which calls `return()` on the
 *   generator it is reading — and `yield*` forwards that to the generator it
 *   delegates to, closing it for good. The first consumer would then leave
 *   nothing for the second to continue from, and both the commit walk and the
 *   release walk are stopped early in exactly this way. Pulling one item at a
 *   time keeps the upstream generator merely suspended.
 * - **Answer only the question asked first.** release-please asks two
 *   different commit questions in plain mode — `latestReleaseVersion` wants
 *   250 commits with no file lists, `buildPullRequests` wants the deep
 *   backfilling walk — and the cheap one is asked first. A cache keyed on the
 *   options is claimed by it, which leaves the expensive walk, the one issue
 *   #54 was about, read afresh in both passes with nothing on screen to say
 *   so. What the two questions differ in is how much of one history they want
 *   and whether they read its file lists, so one read serves both — and this
 *   repository, which releases in plain mode, paid for three walks per pull
 *   request until it did (issue #65).
 * - **Let a walk that failed look like a walk that ended.** A generator that
 *   threw is completed, so pulling it again answers `done` — and a second
 *   consumer served that sees a short history rather than an error. The error
 *   is kept and rethrown to whoever asks past the point it happened.
 */

import type { Commit, GitHub } from "release-please";

/** Yielded is what an async generator hands out. release-please's index
 * exports neither the release nor the tag shape, so they are read off the
 * methods that yield them rather than deep-imported from build/src. */
type Yielded<G> = G extends AsyncGenerator<infer T, unknown, unknown>
  ? T
  : never;

type ScmRelease = Yielded<ReturnType<GitHub["releaseIterator"]>>;
type ScmTag = Yielded<ReturnType<GitHub["tagIterator"]>>;

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

/** HistorySourceOptions are what a source may be given beyond the client. */
export interface HistorySourceOptions {
  /** files serves commit file lists, when something cheaper than the API can. */
  files?: CommitFiles;
  /**
   * batchSize is how many commits one page of the shared commit walk carries.
   *
   * It is the size the projection's own release-please run walks with, so the
   * one read pages as coarsely as the consumer that matters. Left unset it is
   * release-please's default of ten, which is 25 serial pages to reach a
   * release pull request 250 commits back.
   */
  batchSize?: number;
}

/**
 * UPSTREAM_BATCH_SIZE is the page size release-please walks with when the
 * caller names none — `mergeCommitsGraphQL`'s `first: $num` default, and what
 * its `Manifest` falls back to for a batch size it discards.
 */
export const UPSTREAM_BATCH_SIZE = 10;

/**
 * walkPageSize is how many commits one page of a walk with this batch size
 * carries: what a replayed cap rounds to, and what the shared read fetches
 * with.
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
 * commitCap is how many commits `mergeCommitIterator` yields for a cap of
 * `maxResults` at this page size: the cap rounded up to a whole page.
 *
 * That is the arithmetic behind moving the commit walk's cap to replay.
 * Upstream fetches a page, yields **all** of it, and only then re-checks the
 * cap, so 250 at a page of 10 is 250 commits and at 100 it is 300. The
 * difference is not cosmetic — `latestReleaseVersion` accepts a release only
 * when its sha is one the walk handed over, so a replay that stops anywhere
 * else answers a question release-please never asked.
 *
 * An absent cap is unlimited and stays unlimited; a cap that is not a number
 * yields nothing, which is what upstream's `results < maxResults` does with
 * one.
 */
export function commitCap(maxResults: number, page: number): number {
  return Math.ceil(maxResults / page) * page;
}

/**
 * Slot is one memoized walk: what it has handed out, where it is, and how it
 * ended.
 */
interface Slot<T> {
  /** walked is every item this walk has yielded, in order. */
  walked: T[];
  /** upstream is the walk itself, suspended wherever the furthest consumer
   * left it. */
  upstream: AsyncGenerator<T, void, unknown>;
  /** exhausted records that upstream ran out, so nothing pulls it again. */
  exhausted: boolean;
  /** failed records that upstream threw, so later consumers are told rather
   * than handed a walk that merely looks short. Separate from `failure`
   * because the thrown value may itself be undefined. */
  failed: boolean;
  /** failure is what upstream threw, rethrown to whoever asks past it. */
  failure?: unknown;
  /** queue serializes the pulls. */
  queue: Promise<unknown>;
}

/**
 * sharedWalk memoizes upstream walks so later consumers replay them.
 *
 * The returned function is a walk as a consumer sees it. `question` says what
 * was asked, and each distinct question gets a walk of its own — because a
 * different question is a different answer, and answering it from the wrong
 * cache would be wrong rather than merely slow. Consumers that repeat a
 * question share one walk however many times they ask.
 *
 * `limit` caps what this consumer is handed, which is what upstream's own
 * `maxResults` does to it — applied here rather than upstream so that
 * consumers wanting different amounts of the *same* walk still share one.
 *
 * A cap moves to replay only where the replay stops exactly where upstream
 * would have, and the three walks do not stop the same way. `releaseIterator`
 * and `tagIterator` break inside the page and yield exactly `maxResults`, so
 * the cap is `maxResults`. `mergeCommitIterator` fetches a page, yields
 * **all** of it, and only then re-checks the cap (github.js), so it overshoots
 * to the next page boundary: its cap is `commitCap`, the cap rounded up to a
 * whole page of the size that consumer asked for. Hand it `maxResults`
 * instead and a repository tuning `commit-search-depth` to 450 gets 450 where
 * release-please gives 500, and a release whose sha sits in the fifty it lost
 * stops counting as on-branch — a different last released version, with
 * nothing reporting it.
 */
function sharedWalk<T>(): (
  question: string,
  start: () => AsyncGenerator<T, void, unknown>,
  limit?: number,
) => AsyncGenerator<T> {
  const slots = new Map<string, Slot<T>>();

  /** at returns the nth item of a walk, pulling upstream when the cache does
   * not reach it and undefined once the walk runs out. */
  const at = (slot: Slot<T>, n: number): Promise<T | undefined> => {
    // One pull at a time. The passes are sequential today; a shared generator
    // read from two places at once would interleave, and that is not a
    // failure anyone would enjoy diagnosing.
    const pull = slot.queue.then(async () => {
      if (n < slot.walked.length) return slot.walked[n];
      // A walk that threw is over -- a generator that threw is completed, so
      // pulling it again answers `done` -- and every later consumer is told
      // so. Handing it the part that arrived before the error instead would
      // be a truncated history nothing reports: a missing release boundary,
      // `needsBootstrap`, and a version computed over the wrong span.
      if (slot.failed) throw slot.failure;
      if (slot.exhausted) return undefined;
      try {
        const next = await slot.upstream.next();
        if (next.done) {
          slot.exhausted = true;
          return undefined;
        }
        slot.walked.push(next.value);
        return next.value;
      } catch (error) {
        slot.failed = true;
        slot.failure = error;
        throw error;
      }
    });
    // A rejected pull must not poison the ordering chain: the chain is for
    // ordering, and the error reaches the caller through `pull` itself.
    slot.queue = pull.then(
      () => undefined,
      () => undefined,
    );
    return pull;
  };

  return async function* (
    question: string,
    start: () => AsyncGenerator<T, void, unknown>,
    limit: number = Number.POSITIVE_INFINITY,
  ): AsyncGenerator<T> {
    let slot = slots.get(question);
    if (!slot) {
      slot = {
        walked: [],
        upstream: start(),
        exhausted: false,
        failed: false,
        queue: Promise.resolve(),
      };
      slots.set(question, slot);
    }

    for (let n = 0; n < limit; n++) {
      const item = await at(slot, n);
      if (item === undefined) return;
      yield item;
    }
  };
}

/**
 * question names a walk by everything that decides what it yields.
 *
 * Object keys are sorted, so two callers that wrote the same options in a
 * different order ask the same question. Options are carried whole rather
 * than enumerated field by field: an option this file has never heard of --
 * one a release-please upgrade adds -- then keys a walk of its own instead of
 * silently sharing one with a caller that did not pass it. A cache miss is a
 * recoverable wrong; an answer to a question nobody asked is not.
 *
 * That holds for anything JSON can write, which is every option
 * release-please has ever passed these -- `ScmCommitIteratorOptions`,
 * `ScmReleaseIteratorOptions` and `ScmTagIteratorOptions` are numbers and
 * booleans and nothing else. **A function-valued option would key as absent**,
 * and two callers differing only in one would share a walk. Nothing today is
 * one; check this when an upgrade adds an option that is not a scalar.
 */
function question(...parts: unknown[]): string {
  return JSON.stringify(parts, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : value,
  );
}

/**
 * historySource wraps a release-please `GitHub` so the repository's history is
 * read once and commit file lists come from the cheapest source available.
 *
 * The wrap is an object whose prototype is the client, the same arrangement
 * pr-view.ts uses: inherited methods keep working and the overridden ones are
 * own properties shadowing them. The upstream commit iterator is created with
 * the wrapper as its receiver, so the file-list override is the one
 * release-please reaches for while backfilling.
 *
 * pr-view.ts wraps this in turn, and its view inherits these overrides rather
 * than replacing them — so both projection passes share one cache even though
 * only one of them sees the synthetic commit.
 *
 * A client with no `mergeCommitIterator` is returned untouched. That is the
 * seam having moved, which is pr-view.ts's error to raise — it is the one that
 * can explain what breaks.
 */
export function historySource(
  github: GitHub,
  options: HistorySourceOptions = {},
): GitHub {
  if (typeof github.mergeCommitIterator !== "function") return github;

  const source: GitHub = Object.create(github);

  // Nothing is shadowed that is not there to shadow. A wrapper that installed
  // an override over a missing method would turn a moved seam into
  // `github.releaseIterator is not a function`, thrown from inside a
  // generator, rather than handing the client back as it found it.
  const serve = options.files;
  if (serve && typeof github.getCommitFiles === "function") {
    source.getCommitFiles = async function (sha: string): Promise<string[]> {
      return serve(sha) ?? (await github.getCommitFiles(sha));
    };
  }

  // The options the one shared commit walk is started with.
  //
  // `backfillFiles` is on regardless of what a consumer asks for, because a
  // commit fetched without it cannot be upgraded afterwards: upstream reads
  // `pageInfo.hasNextPage` on the pull request's file list to decide whether a
  // REST call is needed, and the commit it yields does not carry that flag. So
  // the walk that fills the cache is the backfilling one, and a consumer that
  // asked for no file lists is handed commits carrying them anyway, which it
  // does not read.
  //
  // That is not free, and the release search is the consumer it is not free
  // for. It can reach *further* than the pull request build, which stops at
  // the release boundary, and upstream backfills a whole page before yielding
  // its first commit -- so replaying 250 commits to it backfills the 300 the
  // shared walk fetched, where release-please would have walked those 250 in
  // pages of ten with no file lists at all. Where the checkout is deep the
  // index in git.ts answers every one of them; where it is shallow they are
  // REST calls, against the round trips per page the shared walk saves.
  //
  // The page size is one for all of them, and upstream counts a merge commit's
  // pull requests per page -- which decides whether a commit's file list is
  // its pull request's or a backfill of its own diff, and, for a commit GitHub
  // associates with more than one pull request, which of them the commit
  // carries. The file lists are safe: the consumer that reads them is handed
  // the page size its own run uses, and the release search reads no files.
  // Which pull request a commit carries is not proved safe, only narrow -- it
  // takes a commit that GitHub associates with a second pull request, sharing
  // its page with another commit of the first, at a boundary the finer pages
  // did not have.
  //
  // No cap is written here. Every consumer's is applied to what it is handed,
  // and the walk is pulled one commit at a time, so it fetches no page nobody
  // asked to read.
  const walkOptions: Parameters<GitHub["mergeCommitIterator"]>[1] = {
    backfillFiles: true,
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
  };

  const commits = sharedWalk<Commit>();
  source.mergeCommitIterator = function (
    targetBranch: string,
    iteratorOptions?: Parameters<GitHub["mergeCommitIterator"]>[1],
  ): AsyncGenerator<Commit> {
    // The branch and nothing else, because one read answers every question
    // asked of that branch. `latestReleaseVersion` asks for 250 commits with
    // no file lists and `buildPullRequests` for the deep backfilling walk, so
    // keying on the options gave those two separate walks over the same pages
    // -- read once here, and the difference between them is applied below
    // (issue #65).
    return commits(
      question(targetBranch),
      () => github.mergeCommitIterator.call(source, targetBranch, walkOptions),
      commitCap(
        iteratorOptions?.maxResults ?? Number.POSITIVE_INFINITY,
        walkPageSize(iteratorOptions?.batchSize),
      ),
    );
  } as GitHub["mergeCommitIterator"];

  // The cap is the one option release-please passes these two, and it is
  // applied to what a consumer is handed rather than to the walk -- so it is
  // taken out of the question, and every consumer shares one walk. Anything
  // else an upgrade adds stays in the question and is passed upstream, where
  // it keys a walk of its own.
  //
  // The two coercions are upstream's own and differ: `releaseIterator` reads
  // `maxResults` with `??` and honours a zero, `tagIterator` reads it with
  // `||` and treats zero as unlimited. Neither is asked for zero today.
  // Normalising them would make this answer a question release-please would
  // not, so they are mirrored and measured against the real client rather
  // than against a fake -- see "caps its walks exactly as release-please's own
  // do" in history.test.ts.
  if (typeof github.releaseIterator === "function") {
    const releases = sharedWalk<ScmRelease>();
    source.releaseIterator = function (
      iteratorOptions?: Parameters<GitHub["releaseIterator"]>[0],
    ): AsyncGenerator<ScmRelease> {
      const { maxResults, ...rest } = iteratorOptions ?? {};
      return releases(
        question(rest),
        () => github.releaseIterator.call(source, rest),
        maxResults ?? Number.POSITIVE_INFINITY,
      );
    } as GitHub["releaseIterator"];
  }

  if (typeof github.tagIterator === "function") {
    const tags = sharedWalk<ScmTag>();
    source.tagIterator = function (
      iteratorOptions?: Parameters<GitHub["tagIterator"]>[0],
    ): AsyncGenerator<ScmTag> {
      const { maxResults, ...rest } = iteratorOptions ?? {};
      return tags(
        question(rest),
        () => github.tagIterator.call(source, rest),
        maxResults || Number.POSITIVE_INFINITY,
      );
    } as GitHub["tagIterator"];
  }

  return source;
}
