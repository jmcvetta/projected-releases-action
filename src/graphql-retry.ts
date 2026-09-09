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
 * **What it does not cover.** `releaseIterator` delegates to a separate client
 * object the instance holds, and `tagIterator` is REST pagination; neither goes
 * through `graphqlRequest`, and neither carries a page size to shrink. Only the
 * commit walk is retried here, which is where the failure was observed.
 *
 * **A walk that gives up must not read as a walk that ended.** release-please
 * gives up on a request by returning `undefined`, and `mergeCommitIterator`
 * reads a missing response as a branch that does not exist and breaks out of
 * its loop. Left alone, a request that ran out of retries is a *short history*
 * rather than an error: a missing release boundary, `needsBootstrap`, and a
 * version computed over the wrong span, with nothing on screen saying so. So
 * this throws on both ways of giving up — its own attempts running out, and
 * upstream's returning nothing.
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
 * shrink halves the page this request asks for, so a retry asks GitHub for
 * less work than the attempt that failed, and says what it settled on.
 *
 * `num` is `mergeCommitsGraphQL`'s page-size variable. A request without it is
 * left alone, and the final retry goes to a single commit — both as upstream
 * does with the 502 it retries.
 */
function shrink(
  opts: Record<string, unknown>,
  left: number,
): number | undefined {
  if (typeof opts.num !== "number" || opts.num <= 1) return undefined;
  const next = left <= 1 ? 1 : Math.max(1, Math.floor(opts.num / 2));
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

/**
 * retryingGraphql wraps a release-please client so a transient GraphQL failure
 * in the commit walk is asked again instead of ending the run.
 *
 * The wrap is an object whose prototype is the client, the same arrangement
 * history.ts and pr-view.ts use: inherited methods keep working and the
 * override is an own property shadowing one.
 *
 * A client with no `graphqlRequest` is returned untouched — nothing is
 * shadowed that is not there to shadow. That is a seam whose failure is
 * silence, so the tests that hold it drive real release-please over a fake
 * GitHub that fails a page: move the seam upstream and they fail, rather than
 * the retries quietly ceasing to happen.
 */
export function retryingGraphql(
  github: GitHub,
  options: RetryOptions = {},
): GitHub {
  const holder = github as unknown as { graphqlRequest?: unknown };
  if (typeof holder.graphqlRequest !== "function") return github;

  const original = holder.graphqlRequest as GraphqlRequestFn;
  const retries = options.retries ?? RETRIES;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const log = options.log ?? ((message: string) => console.error(message));

  // The largest page each query has been served, keyed by the query itself.
  // See the note on shrinking above: a walk is many requests, and climbing
  // back to a size GitHub has already refused would pay a failure and a
  // backoff on every page.
  //
  // Per query rather than per client, because two queries asking for the same
  // number of nodes are not asking for the same work, and one of them
  // settling at a smaller page says nothing about the other.
  const ceilings = new Map<string, number>();

  const source: GitHub = Object.create(github);
  (source as unknown as { graphqlRequest: GraphqlRequestFn }).graphqlRequest =
    async function (
      opts: Record<string, unknown>,
      requestOptions?: unknown,
    ): Promise<unknown> {
      const query = String(opts.query ?? "");
      const ceiling = ceilings.get(query) ?? Number.POSITIVE_INFINITY;
      if (typeof opts.num === "number" && opts.num > ceiling) {
        opts.num = ceiling;
      }
      let left = retries;
      let seconds = 1;
      for (;;) {
        try {
          const answer = await original(opts, requestOptions);
          if (answer === undefined) {
            // Upstream's own loop gave up, and it gives up by returning
            // nothing. Reported as a value, that is a walk which ends early
            // and looks finished.
            throw new Error(
              "GitHub did not answer the GraphQL query for the branch's" +
                " commits, and release-please ran out of retries",
            );
          }
          // What was served, not what was last tried: a request that ran out
          // of halvings and succeeded at one commit is the only thing that
          // makes a page of one the ceiling.
          if (typeof opts.num === "number" && opts.num < ceiling) {
            ceilings.set(query, opts.num);
          }
          return answer;
        } catch (error) {
          if (left <= 0 || !transientGraphqlError(error)) throw error;
          const page = shrink(opts, left);
          log(
            "GitHub failed a GraphQL query on its own side; asking again" +
              ` in ${seconds}s, ${left} attempt(s) left` +
              (page === undefined ? "" : ` at a page of ${page}`),
          );
          await sleep(1000 * seconds);
          seconds = Math.min(seconds * 2, MAX_SLEEP_SECONDS);
          left -= 1;
        }
      }
    };
  return source;
}
