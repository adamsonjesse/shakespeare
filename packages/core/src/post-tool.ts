import { postMessage, type PostedMessage } from "./events.ts";
import type { SqlExecutor } from "./storage.ts";

/**
 * Local `post_message` tool. The signed origin is always `ai`. A caller-supplied
 * origin is ignored, including `human`. The composer does not use this function.
 */
export async function postMessageTool(
  db: SqlExecutor,
  author: { readonly publicKey: string; readonly privateKey: Uint8Array },
  input: {
    readonly clubId: string;
    readonly body: string;
    readonly now: string;
    readonly parentId?: string | null;
    readonly origin?: string;
  },
): Promise<PostedMessage> {
  return postMessage(db, author, {
    clubId: input.clubId,
    body: input.body,
    now: input.now,
    parentId: input.parentId,
    origin: "ai",
  });
}

/** CLI entry for the same tool. Tests call this instead of a live model. */
export async function runPostMessageCli(
  db: SqlExecutor,
  author: { readonly publicKey: string; readonly privateKey: Uint8Array },
  input: {
    readonly clubId: string;
    readonly body: string;
    readonly now: string;
    readonly origin?: string;
  },
): Promise<PostedMessage & { readonly origin: "ai" }> {
  const posted = await postMessageTool(db, author, input);
  return { ...posted, origin: "ai" };
}
