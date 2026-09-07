/**
 * comment keeps one sticky comment on a pull request.
 *
 * Sticky because the projection is a statement about the current head, not a
 * log: a push, a title edit or a body edit each produce a new answer, and a
 * new comment per event would bury the pull request in stale ones. Editing in
 * place also means no notification for a re-render that says the same thing.
 *
 * The comment is found by a hidden HTML marker it writes into its own body,
 * never by "the newest comment from this identity" — a repository whose CI
 * leaves its own comments under the same bot would collide with that.
 */

import type { Client, IssueComment } from "./api.js";

/** DEFAULT_HEADER names the sticky comment when the caller does not. */
export const DEFAULT_HEADER = "projected-releases";

/** markerFor is the hidden line that identifies one sticky comment. */
export function markerFor(header: string): string {
  return `<!-- sticky-comment: ${header} -->`;
}

/** withMarker prefixes a body with its marker, idempotently. */
export function withMarker(header: string, body: string): string {
  const marker = markerFor(header);
  return body.includes(marker) ? body : `${marker}\n${body}`;
}

/** findSticky returns the existing comment carrying a marker, if any. */
export function findSticky(
  comments: readonly IssueComment[],
  header: string,
): IssueComment | undefined {
  const marker = markerFor(header);
  return comments.find((comment) => comment.body.includes(marker));
}

/** StickResult says what happened, so the log can distinguish a first post
 * from a re-render. */
export interface StickResult {
  action: "created" | "updated" | "unchanged";
  id: number;
}

/**
 * stick posts or updates the pull request's projected-releases comment.
 *
 * A body identical to what is already there is left alone. The footer carries
 * a timestamp, so in practice this only fires when a caller renders without
 * one — but a no-op PATCH still bumps the comment's `updated_at`, and not
 * writing is cheaper than writing.
 *
 * `listed` is the comment list a caller has already started reading, since
 * the read does not depend on the body and the body takes seconds to render.
 * It is an optional argument rather than a required one because the read is
 * this function's own business: a caller that has nothing to hand over says
 * nothing, and one whose head start failed hands over `undefined` and gets
 * the read it would have had.
 *
 * Finding *no* comment in a handed-over list is confirmed against a fresh
 * read, and that is not caution for its own sake. The list was read before
 * the body was rendered, which is seconds and on a slow repository much more,
 * and an absence is the one answer that decides an action rather than a body:
 * two runs that both saw none both create, `findSticky` serves the first of
 * the two from then on, and the second is left showing a stale projection
 * that nothing will ever edit or remove. A body read from a stale list costs
 * nothing by comparison, because it is overwritten with this one. So the
 * confirming read is paid on a pull request's first comment and never again.
 */
export async function stick(
  client: Client,
  number: number,
  header: string,
  body: string,
  listed?: Promise<readonly IssueComment[] | undefined>,
): Promise<StickResult> {
  const full = withMarker(header, body);
  const head = await listed;
  let existing = findSticky(head ?? (await client.issueComments(number)), header);
  if (!existing && head) {
    existing = findSticky(await client.issueComments(number), header);
  }
  if (!existing) {
    const created = await client.createComment(number, full);
    return { action: "created", id: created.id };
  }
  if (existing.body === full) return { action: "unchanged", id: existing.id };
  await client.updateComment(existing.id, full);
  return { action: "updated", id: existing.id };
}
