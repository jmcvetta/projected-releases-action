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
 * The releases and the tags are read more times still, because each pass asks
 * for them twice. `Manifest.fromConfig` resolves the last release through
 * `latestReleaseVersion`, and `buildPullRequests` resolves it again per
 * component — so a plain-mode projection listed the releases four times, with
 * identical pages, before this cached them (issue #66). The two callers do
 * not agree on how many they want: `latestReleaseVersion` asks for all of
 * them and `buildPullRequests` caps the walk at the release search depth. So
 * the upstream walk is started uncapped and each consumer's cap is applied to
 * what it is handed, which reads the same pages upstream would have read for
 * the uncapped caller and no more.
 *
 * So every walk is memoized. The cache is filled by the first consumer as it
 * is consumed, and a later one replays it and continues the same upstream
 * iterator where the first one stopped — never a fresh one, which would ask
 * for the same pages again.
 *
 * Two things this must not do, both of which look right and are not:
 *
 * - **Delegate to the upstream iterator with `yield*`.** release-please stops
 *   a walk by breaking out of a `for await`, which calls `return()` on the
 *   generator it is reading — and `yield*` forwards that to the generator it
 *   delegates to, closing it for good. The first consumer would then leave
 *   nothing for the second to continue from, and both the commit walk and the
 *   release walk are stopped early in exactly this way. Pulling one item at a
 *   time keeps the upstream generator merely suspended.
 * - **Assume two walks want the same thing.** A call with different options is
 *   a different question, and is delegated whole rather than answered from
 *   the cache.
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
}

/**
 * sharedWalk memoizes one upstream walk so later consumers replay it.
 *
 * The returned function is the walk as a consumer sees it. `question`
 * identifies what was asked: the first question starts the upstream walk and
 * a different one is handed a walk of its own, since answering it from the
 * cache would answer it wrongly. `limit` caps what this consumer is handed,
 * which is what upstream's own `maxResults` does to it — applied here rather
 * than upstream so that consumers wanting different amounts of the same walk
 * still share one.
 */
function sharedWalk<T>(): (
  question: string,
  start: () => AsyncGenerator<T, void, unknown>,
  limit?: number,
) => AsyncGenerator<T> {
  // The question the cache holds an answer to.
  let asked: string | undefined;
  const walked: T[] = [];
  let upstream: AsyncGenerator<T, void, unknown> | undefined;
  let exhausted = false;
  // One pull at a time. The passes are sequential today; a shared generator
  // read from two places at once would interleave, and that is not a failure
  // anyone would enjoy diagnosing.
  let queue: Promise<unknown> = Promise.resolve();

  /** at returns the nth item of the walk, pulling upstream when the cache
   * does not reach it and undefined once the walk runs out. */
  const at = (n: number): Promise<T | undefined> => {
    const pull = queue.then(async () => {
      if (n < walked.length) return walked[n];
      if (exhausted || !upstream) return undefined;
      const next = await upstream.next();
      if (next.done) {
        exhausted = true;
        return undefined;
      }
      walked.push(next.value);
      return next.value;
    });
    // A rejected pull must not poison every later one: the chain is for
    // ordering, and the error belongs to the caller that asked.
    queue = pull.then(
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
    if (asked === undefined) {
      asked = question;
      upstream = start();
    } else if (question !== asked) {
      // A walk of this consumer's own, which it may close as it likes.
      yield* start();
      return;
    }

    for (let n = 0; n < limit; n++) {
      const item = await at(n);
      if (item === undefined) return;
      yield item;
    }
  };
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
  const serve = options.files;
  if (serve) {
    source.getCommitFiles = async function (sha: string): Promise<string[]> {
      return serve(sha) ?? (await github.getCommitFiles(sha));
    };
  }

  const commits = sharedWalk<Commit>();
  source.mergeCommitIterator = function (
    targetBranch: string,
    iteratorOptions?: Parameters<GitHub["mergeCommitIterator"]>[1],
  ): AsyncGenerator<Commit> {
    // Every option upstream reads, because each of them changes the answer:
    // the cap on the walk, whether file lists are backfilled, and the page
    // size. `latestReleaseVersion` asks for 250 commits with none of the rest,
    // which is not the walk `buildPullRequests` asks for.
    const question = JSON.stringify([
      targetBranch,
      iteratorOptions?.maxResults ?? null,
      iteratorOptions?.backfillFiles ?? null,
      iteratorOptions?.batchSize ?? null,
    ]);
    return commits(question, () =>
      github.mergeCommitIterator.call(source, targetBranch, iteratorOptions),
    );
  } as GitHub["mergeCommitIterator"];

  // Releases and tags take no option but the cap, so there is only ever one
  // question and every consumer shares the walk. The cap is what each of them
  // is handed, and the coercions below are upstream's own: `releaseIterator`
  // reads a zero as zero and `tagIterator` reads it as unlimited. Normalising
  // the two would make this answer a question release-please would not.
  const releases = sharedWalk<ScmRelease>();
  source.releaseIterator = function (
    iteratorOptions?: Parameters<GitHub["releaseIterator"]>[0],
  ): AsyncGenerator<ScmRelease> {
    return releases(
      "",
      () => github.releaseIterator.call(source),
      iteratorOptions?.maxResults ?? Number.POSITIVE_INFINITY,
    );
  } as GitHub["releaseIterator"];

  const tags = sharedWalk<ScmTag>();
  source.tagIterator = function (
    iteratorOptions?: Parameters<GitHub["tagIterator"]>[0],
  ): AsyncGenerator<ScmTag> {
    return tags(
      "",
      () => github.tagIterator.call(source),
      iteratorOptions?.maxResults || Number.POSITIVE_INFINITY,
    );
  } as GitHub["tagIterator"];

  return source;
}
