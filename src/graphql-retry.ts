/**
 * graphql-retry retries the commit walk's GraphQL request when GitHub answers
 * it with a failure on its own side, shrinking the page as it goes.
 *
 * GitHub reports such a failure as an HTTP 200 whose body carries an `errors`
 * array — `Something went wrong while executing your query`, which is what its
 * backend returns for a query it could not finish in time. Octokit raises it
 * as a `GraphqlResponseError`, and that error carries no `status`, so
 * release-please's own retry loop (`err.status !== 502` and it rethrows) drops
 * it on the first attempt. One page failing that way ends the projection:
 * `project` catches the second pass and not the first, so the run fails with a
 * stack trace where a comment should be (issue #74).
 *
 * Every request this covers is a read, so repeating one is free of
 * consequence.
 *
 * **Why the page shrinks.** This action pages the commit walk at
 * `COMMIT_BATCH_SIZE` (100) where release-please pages at ten, and upstream's
 * query asks, per commit, for ten associated pull requests each carrying a
 * hundred file paths. One page at 100 therefore asks GitHub for up to ten
 * times the work release-please's own run asks for. That is the query observed
 * failing, on two repositories of very different sizes within the same hour —
 * the requested page is the same in both, which is what a history's length
 * does not change. Halving on each retry is upstream's own answer to a 502 in
 * the same loop, and the cursor is per page, so a smaller page changes where
 * the walk stops for breath and nothing about what it yields. The size that
 * worked is then kept for the rest of the run: a page GitHub could not finish
 * says something about the query and the hour rather than about the page it
 * failed on, and a walk that climbed back to it would pay a failure and a
 * backoff on every page of the history.
 *
 * **The seam is `graphqlRequest`, and the obvious one does not work.**
 * `mergeCommitsGraphQL` calls `this.graphqlRequest`, and it is an ordinary
 * prototype method, so `this` is whatever the iterator was started with and an
 * override on a wrapper is reached. `graphqlRequest` itself then calls
 * `this.graphql` — but it is an **arrow function assigned in the
 * constructor**, so its `this` is the instance it was built on, captured
 * lexically and immune to the receiver. Shadowing `graphql` therefore compiles,
 * runs, changes nothing, and says nothing about it.
 *
 * **Every GraphQL walk is covered, and they do not all live on one object.**
 * The commit walk goes through the client's own `graphqlRequest`; the release
 * and pull request walks are delegated to a `gitHubApi` the client holds,
 * which has a `graphqlRequest` of its own. Both are wrapped, because a
 * projection asks for the releases on every run and the same failure there
 * lands in the same uncaught pass. `tagIterator` is REST pagination and is
 * covered by neither.
 *
 * **A walk that gives up must not read as a walk that ended.** release-please
 * gives up on a request by returning `undefined`, and `mergeCommitIterator`
 * reads a missing response as a branch that does not exist and breaks out of
 * its loop. Left alone, a request that ran out of retries is a *short history*
 * rather than an error: a missing release boundary, `needsBootstrap`, and a
 * version computed over the wrong span, with nothing on screen saying so. So
 * this throws on both ways of giving up — its own attempts running out, and
 * upstream's returning nothing. `releaseIterator` breaks on a missing response
 * in the same way, so it is the same failure on the same footing.
 */

import type { GitHub } from "release-please";

/**
 * TRANSIENT_MESSAGE is how GitHub words a failure on its own side: the whole
 * message continues with a reference number to quote when reporting it.
 */
export const TRANSIENT_MESSAGE =
  "Something went wrong while executing your query";

/**
 * TRANSIENT_TYPES are the GraphQL error types that describe GitHub failing
 * rather than the query being wrong.
 *
 * Everything else it types — `NOT_FOUND`, `FORBIDDEN`, `INSUFFICIENT_SCOPES`,
 * `RATE_LIMITED` — answers the same way however often it is asked, and
 * `RATE_LIMITED` answers worse: retrying it spends the little budget that is
 * left and defers the error that says what happened.
 */
const TRANSIENT_TYPES = new Set(["SERVICE_UNAVAILABLE", "INTERNAL"]);

/**
 * OVERSIZED_TYPE is GitHub refusing a query for asking for too many nodes at
 * once — a refusal rather than a failure, and the one a smaller page answers.
 */
const OVERSIZED_TYPE = "MAX_NODE_LIMIT_EXCEEDED";

/** RETRIES is how many further attempts a transient failure gets, matching
 * release-please's own count for the 502 it does retry. */
export const RETRIES = 5;

/** MAX_SLEEP_SECONDS caps the backoff, as it does upstream. */
const MAX_SLEEP_SECONDS = 20;

/** RetryOptions are the knobs a caller other than the action needs. */
export interface RetryOptions {
  /** retries is how many further attempts a transient failure gets. */
  retries?: number;
  /** sleep waits between attempts. A test supplies its own rather than
   * spending the backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** log records each retry, so a slow step says why it was slow. */
  log?: (message: string) => void;
}

/** transientOne says whether one entry of an `errors` array describes GitHub
 * failing rather than the query being wrong. */
function transientOne(one: unknown): boolean {
  if (!one || typeof one !== "object") return false;
  const { message, type } = one as { message?: unknown; type?: unknown };
  // A typed error is judged by its type alone: GitHub types the errors it can
  // name, and a message that happens to read like the untyped one does not
  // make `FORBIDDEN` worth asking twice.
  if (typeof type === "string") return TRANSIENT_TYPES.has(type);
  return typeof message === "string" && message.startsWith(TRANSIENT_MESSAGE);
}

/**
 * transientGraphqlError says whether an error is a GraphQL response GitHub
 * failed to produce, rather than one it refused to.
 *
 * Every entry has to be transient. A response mixing a server failure with a
 * `FORBIDDEN` will answer the same way next time, and retrying it only defers
 * the half of the report that says what to fix.
 */
export function transientGraphqlError(error: unknown): boolean {
  const errors = (error as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every(transientOne);
}

/**
 * oversizedGraphqlError says whether GitHub refused the query for asking too
 * much at once.
 *
 * It is not a transient failure — asked again unchanged it is refused again —
 * but it is the one refusal a *smaller* attempt answers, which is what a retry
 * here does. So it counts only where there is a page left to halve; without
 * one, the attempts would spend the backoff to arrive at the same refusal.
 */
export function oversizedGraphqlError(error: unknown): boolean {
  const errors = (error as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every(
    (one) =>
      !!one &&
      typeof one === "object" &&
      (one as { type?: unknown }).type === OVERSIZED_TYPE,
  );
}

/** retryable says whether this failure is worth asking about again, given what
 * the request still has to give up. */
function retryable(error: unknown, opts: Record<string, unknown>): boolean {
  if (transientGraphqlError(error)) return true;
  return (
    oversizedGraphqlError(error) &&
    typeof opts.num === "number" &&
    opts.num > 1
  );
}

/**
 * shrink halves the page this request asks for, so a retry asks GitHub for
 * less work than the attempt that failed, and says what it settled on.
 *
 * `num` is the page-size variable of every one of these queries. A request
 * without one is left alone.
 *
 * Upstream drops straight to a single commit on its own last retry. This does
 * not, and the reason is the ceiling below: the size that finally worked is
 * kept for the rest of the run, so a page of one taken as an emergency for one
 * request would become the setting for every page after it — a five-page walk
 * turned into five hundred serial requests by one bad minute. Halving all the
 * way down keeps every size the ladder reaches a size worth keeping.
 */
function shrink(opts: Record<string, unknown>): number | undefined {
  if (typeof opts.num !== "number" || opts.num <= 1) return undefined;
  const next = Math.max(1, Math.floor(opts.num / 2));
  opts.num = next;
  return next;
}

/** GraphqlRequestFn is release-please's own GraphQL entry point, which it
 * declares private: the query and its variables in one object, and the retry
 * budget its own loop uses in another. */
type GraphqlRequestFn = (
  opts: Record<string, unknown>,
  options?: unknown,
) => Promise<unknown>;

/** Holder is anything of release-please's that owns a `graphqlRequest`. */
interface Holder {
  graphqlRequest?: unknown;
  gitHubApi?: unknown;
}

/** Retrying is the settled configuration one wrap runs under. */
interface Retrying {
  retries: number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  /**
   * ceilings is the page each query has settled at, keyed by the query.
   *
   * A walk is many requests, so climbing back to a size GitHub has already
   * refused pays a failure and a backoff on every page. Per query, because two
   * queries asking for the same number of nodes are not asking for the same
   * work, and one of them settling smaller says nothing about the other.
   *
   * One map across every object wrapped, since the key is the query text.
   */
  ceilings: Map<string, number>;
}

/** wrap shadows one object's `graphqlRequest` with the retrying one, or
 * answers undefined for an object that has none to shadow. */
function wrap(holder: Holder, run: Retrying): object | undefined {
  if (typeof holder.graphqlRequest !== "function") return undefined;
  const original = holder.graphqlRequest as GraphqlRequestFn;

  const source = Object.create(holder) as Holder;
  (source as { graphqlRequest: GraphqlRequestFn }).graphqlRequest =
    async function (
      opts: Record<string, unknown>,
      requestOptions?: unknown,
    ): Promise<unknown> {
      const query = String(opts.query ?? "");
      const settled = run.ceilings.get(query);
      if (settled !== undefined && typeof opts.num === "number") {
        opts.num = Math.min(opts.num, settled);
      }
      let left = run.retries;
      let seconds = 1;
      let shrunk = false;
      for (;;) {
        try {
          const answer = await original(opts, requestOptions);
          if (answer === undefined) {
            // Upstream's own loop gave up, and it gives up by returning
            // nothing. Reported as a value, that is a walk which ends early
            // and looks finished.
            throw new Error(
              "GitHub did not answer a GraphQL query, and release-please ran" +
                " out of retries",
            );
          }
          // Only a page this call actually shrank is remembered, and only
          // downwards. Recording every success instead would let a consumer
          // that legitimately asks for less set the size for one that asks
          // for more.
          if (shrunk && typeof opts.num === "number") {
            run.ceilings.set(query, opts.num);
          }
          return answer;
        } catch (error) {
          if (left <= 0 || !retryable(error, opts)) throw error;
          const page = shrink(opts);
          shrunk = shrunk || page !== undefined;
          run.log(
            "GitHub would not answer a GraphQL query; asking again in" +
              ` ${seconds}s, ${left} attempt(s) left` +
              (page === undefined ? "" : ` at a page of ${page}`),
          );
          await run.sleep(1000 * seconds);
          seconds = Math.min(seconds * 2, MAX_SLEEP_SECONDS);
          left -= 1;
        }
      }
    };
  return source;
}

/**
 * retryingGraphql wraps a release-please client so a GraphQL failure it can
 * answer by asking again is asked again instead of ending the run.
 *
 * The wrap is an object whose prototype is the client, the same arrangement
 * history.ts and pr-view.ts use: inherited methods keep working and the
 * override is an own property shadowing one.
 *
 * Both objects that hold a `graphqlRequest` are wrapped: the client's own,
 * which the commit walk goes through, and the `gitHubApi` it delegates the
 * release and pull request walks to. The second is reached because
 * `GitHub.releaseIterator` reads `this.gitHubApi`, so an own property on the
 * wrapper is what its own iterator then runs against.
 *
 * A client holding neither is returned untouched — nothing is shadowed that is
 * not there to shadow. That is a seam whose failure is silence, so the tests
 * that hold it drive real release-please over a fake GitHub that fails a page:
 * move the seam upstream and they fail, rather than the retries quietly
 * ceasing to happen.
 */
export function retryingGraphql(
  github: GitHub,
  options: RetryOptions = {},
): GitHub {
  const run: Retrying = {
    retries: options.retries ?? RETRIES,
    sleep:
      options.sleep ??
      ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))),
    log: options.log ?? ((message: string) => console.error(message)),
    ceilings: new Map<string, number>(),
  };

  const holder = github as unknown as Holder;
  const inner =
    holder.gitHubApi && typeof holder.gitHubApi === "object"
      ? wrap(holder.gitHubApi as Holder, run)
      : undefined;
  const outer = wrap(holder, run);
  if (!outer && !inner) return github;

  const source = (outer ?? Object.create(github)) as Holder;
  if (inner) source.gitHubApi = inner;
  return source as unknown as GitHub;
}
