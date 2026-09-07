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
 * `latestReleaseVersion`, and `buildPullRequests` walks them again to resolve
 * every component's — so a plain-mode projection listed the releases four
 * times, with identical pages, before this cached them (issue #66). The two
 * callers do not agree on how many they want: `latestReleaseVersion` asks for
 * all of them and `buildPullRequests` caps the walk at the release search
 * depth. So the upstream walk is started uncapped and each consumer's cap is
 * applied to what it is handed, which reads the same pages upstream would
 * have read for the uncapped caller and no more.
 *
 * So every walk is memoized, one cache per distinct set of options. A cache is
 * filled by the first consumer as it is consumed, and a later one replays it
 * and continues the same upstream iterator where the first one stopped — never
 * a fresh one, which would ask for the same pages again.
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
 * - **Cache one walk and re-read the rest.** release-please asks two different
 *   commit questions in plain mode — `latestReleaseVersion` wants 250 commits
 *   with no file lists, `buildPullRequests` wants the deep backfilling walk —
 *   and the cheap one is asked first. A single-slot cache is claimed by it,
 *   which leaves the expensive walk, the one issue #54 was about, read afresh
 *   in both passes with nothing on screen to say so.
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
  /** failure is the error upstream threw, kept so later consumers are told
   * rather than handed a walk that merely looks short. */
  failed: boolean;
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
 * consumers wanting different amounts of the *same* walk still share one. A
 * cap belongs in the question instead wherever it changes the items rather
 * than only how many of them there are, which is why the commit walk passes
 * its `maxResults` upstream and the release walk does not: a commit walk also
 * carries `backfillFiles`, and a walk that yielded commits with empty file
 * lists to a consumer expecting them would attribute every commit to no
 * component and silently release nothing.
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
    // Every option upstream reads, because each of them changes what the walk
    // yields: the cap, whether file lists are backfilled, and the page size.
    // `latestReleaseVersion` asks for 250 commits with none of the rest, which
    // is not the walk `buildPullRequests` asks for -- so in plain mode these
    // are two questions and each gets a cache of its own.
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

  // Releases and tags take no option but the cap, and a cap is applied to what
  // a consumer is handed rather than to the walk -- so there is nothing left
  // to tell two questions apart, and the constant below says so.
  //
  // The coercions are upstream's own and differ: `releaseIterator` reads
  // `maxResults` with `??` and honours a zero, `tagIterator` reads it with
  // `||` and treats zero as unlimited. Neither is asked for zero today.
  // Normalising them would make this answer a question release-please would
  // not, so they are mirrored and measured against the real client rather
  // than against a fake -- see "caps its walks exactly as release-please's own
  // do" in history.test.ts.
  //
  // Each override is installed only if the method it shadows is there. These
  // two are an optimization rather than the seam the projection depends on, so
  // a client without them is served rather than wrapped in a call that would
  // throw from inside a generator.
  const ALL = "";
  if (typeof github.releaseIterator === "function") {
    const releases = sharedWalk<ScmRelease>();
    source.releaseIterator = function (
      iteratorOptions?: Parameters<GitHub["releaseIterator"]>[0],
    ): AsyncGenerator<ScmRelease> {
      return releases(
        ALL,
        () => github.releaseIterator.call(source),
        iteratorOptions?.maxResults ?? Number.POSITIVE_INFINITY,
      );
    } as GitHub["releaseIterator"];
  }

  if (typeof github.tagIterator === "function") {
    const tags = sharedWalk<ScmTag>();
    source.tagIterator = function (
      iteratorOptions?: Parameters<GitHub["tagIterator"]>[0],
    ): AsyncGenerator<ScmTag> {
      return tags(
        ALL,
        () => github.tagIterator.call(source),
        iteratorOptions?.maxResults || Number.POSITIVE_INFINITY,
      );
    } as GitHub["tagIterator"];
  }

  return source;
}
