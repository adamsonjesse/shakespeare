import { listMessages, MessageError, postMessage, readMessage } from "./events.ts";
import {
  downloadSelected,
  FileShareError,
  parseManifest,
  type BlobStore,
  type OutputStore,
} from "./files.ts";
import { listMembers } from "./membership.ts";
import { applyTheme, excludeOrigin, matchingThemeIds, readWeightDelta } from "./rank.ts";
import type { SqlExecutor } from "./storage.ts";
import {
  addBookmark,
  bumpThemeWeights,
  listThemes,
  markRead,
  saveTheme,
  StreamError,
} from "./stream.ts";

/**
 * Local club tools. A post or reply is always signed `ai`. Caller fields named
 * origin or privateKey are ignored. This file does not import Node, so the
 * desktop bundle can use the same functions as the CLI.
 */

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputKeys: readonly string[];
}

export interface ToolContext {
  readonly db: SqlExecutor;
  readonly author: { readonly publicKey: string; readonly privateKey: Uint8Array };
  readonly now: () => string;
  readonly blobs?: BlobStore;
  readonly output?: OutputStore;
  readonly fetchHash?: (hash: string) => Promise<Uint8Array>;
}

export class ToolError extends Error {
  readonly code: "rejected" | "forbidden";

  constructor(code: "rejected" | "forbidden") {
    super(code === "forbidden" ? "The request is not allowed." : "The tool rejected that request.");
    this.name = "ToolError";
    this.code = code;
  }
}

const TOOLS: readonly ToolSpec[] = [
  {
    name: "post_message",
    description: "Post a message signed as AI.",
    inputKeys: ["clubId", "body", "parentId", "now"],
  },
  {
    name: "read_stream",
    description: "Read decrypted messages for this profile. Does not download files.",
    inputKeys: ["clubId", "themeId", "hide", "now"],
  },
  {
    name: "reply",
    description: "Reply in a thread, signed as AI.",
    inputKeys: ["clubId", "body", "parentId", "now"],
  },
  {
    name: "mark_read",
    description: "Mark a message read on this profile.",
    inputKeys: ["eventId", "startedAt", "now"],
  },
  {
    name: "bookmark",
    description: "Bookmark a message on this profile.",
    inputKeys: ["eventId", "now"],
  },
  {
    name: "save_theme",
    description: "Save a local theme.",
    inputKeys: ["id", "name", "terms"],
  },
  {
    name: "list_themes",
    description: "List local themes.",
    inputKeys: [],
  },
  {
    name: "request_download",
    description: "Download the selected files from a manifest message.",
    inputKeys: ["eventId", "paths", "now"],
  },
  {
    name: "list_members",
    description: "List club members.",
    inputKeys: ["clubId"],
  },
];

const TOOL_NAME = /^[a-z_]{1,32}$/;

export function toolCatalog(): readonly ToolSpec[] {
  return TOOLS;
}

/** Fixed text for a tool failure. It does not include the caller's message body. */
export function toolFailureMessage(error: unknown): string {
  if (
    error instanceof ToolError ||
    error instanceof MessageError ||
    error instanceof FileShareError ||
    error instanceof StreamError
  ) {
    return error.message;
  }
  return "The tool rejected that request.";
}

export async function callTool(ctx: ToolContext, name: string, input: unknown): Promise<unknown> {
  const time = ctx.now();
  let eventIds: string[] = [];
  let resultCode = "ok";
  try {
    if (!TOOLS.some((tool) => tool.name === name)) throw new ToolError("forbidden");
    const done = await dispatch(ctx, name, input);
    eventIds = [...done.eventIds];
    return done.value;
  } catch (error) {
    resultCode = resultCodeOf(error);
    throw error;
  } finally {
    await recordAudit(ctx, time, name, eventIds, resultCode);
  }
}

interface Done {
  readonly value: unknown;
  readonly eventIds: readonly string[];
}

async function dispatch(ctx: ToolContext, name: string, input: unknown): Promise<Done> {
  switch (name) {
    case "post_message":
      return postSigned(ctx, input, false);
    case "reply":
      return postSigned(ctx, input, true);
    case "read_stream":
      return readStream(ctx, input);
    case "mark_read":
      return markReadTool(ctx, input);
    case "bookmark":
      return bookmarkTool(ctx, input);
    case "save_theme":
      return saveThemeTool(ctx, input);
    case "list_themes":
      return { value: { themes: await listThemes(ctx.db) }, eventIds: [] };
    case "request_download":
      return downloadTool(ctx, input);
    case "list_members":
      return membersTool(ctx, input);
    default:
      throw new ToolError("forbidden");
  }
}

async function postSigned(ctx: ToolContext, input: unknown, parentRequired: boolean): Promise<Done> {
  const record = asRecord(input);
  const parentId = optionalString(record, "parentId");
  if (parentRequired && parentId === undefined) throw new ToolError("rejected");
  const now = clock(ctx, record);
  if (parentId) await learn(ctx, parentId, now);
  const posted = await postMessage(ctx.db, ctx.author, {
    clubId: requiredString(record, "clubId"),
    body: requiredString(record, "body"),
    now,
    origin: "ai",
    parentId,
  });
  return { value: { id: posted.id, origin: "ai" }, eventIds: [posted.id] };
}

async function readStream(ctx: ToolContext, input: unknown): Promise<Done> {
  const record = asRecord(input);
  const hide = optionalString(record, "hide");
  if (hide !== undefined && hide !== "human" && hide !== "ai") throw new ToolError("rejected");
  let messages = excludeOrigin(
    await listMessages(ctx.db, ctx.author.privateKey, requiredString(record, "clubId")),
    hide ?? null,
  );
  const themeId = optionalString(record, "themeId");
  if (themeId) {
    const theme = (await listThemes(ctx.db)).find((item) => item.id === themeId);
    if (!theme) throw new ToolError("rejected");
    messages = applyTheme(messages, theme.terms);
  }
  const view = messages.map((message) => {
    const manifest = message.body === undefined ? null : parseManifest(message.body);
    return {
      id: message.id,
      verified: message.verified,
      body: message.body,
      origin: message.origin,
      authorPublicKey: message.authorPublicKey,
      createdAt: message.createdAt,
      parentId: message.parentId,
      ...(manifest ? { files: manifest.files.map((file) => ({ path: file.path, size: file.size, hash: file.hash })) } : {}),
    };
  });
  return { value: { messages: view }, eventIds: view.map((message) => message.id) };
}

async function markReadTool(ctx: ToolContext, input: unknown): Promise<Done> {
  const record = asRecord(input);
  const eventId = requiredString(record, "eventId");
  const now = clock(ctx, record);
  const startedAt = optionalString(record, "startedAt");
  await markRead(ctx.db, eventId, now);
  if (startedAt && readWeightDelta(startedAt, now) > 0) await learn(ctx, eventId, now);
  return { value: { eventId }, eventIds: [eventId] };
}

async function bookmarkTool(ctx: ToolContext, input: unknown): Promise<Done> {
  const record = asRecord(input);
  const eventId = requiredString(record, "eventId");
  const now = clock(ctx, record);
  await addBookmark(ctx.db, eventId, now);
  await learn(ctx, eventId, now);
  return { value: { eventId }, eventIds: [eventId] };
}

async function saveThemeTool(ctx: ToolContext, input: unknown): Promise<Done> {
  const record = asRecord(input);
  const id = requiredString(record, "id");
  await saveTheme(ctx.db, {
    id,
    name: requiredString(record, "name"),
    terms: stringArray(record, "terms"),
  });
  return { value: { id }, eventIds: [] };
}

async function downloadTool(ctx: ToolContext, input: unknown): Promise<Done> {
  const record = asRecord(input);
  const eventId = requiredString(record, "eventId");
  const paths = stringArray(record, "paths");
  if (paths.length === 0 || !ctx.fetchHash || !ctx.blobs || !ctx.output) throw new ToolError("rejected");
  const message = await readMessage(ctx.db, ctx.author.privateKey, eventId);
  const manifest = message.body === undefined ? null : parseManifest(message.body);
  if (!manifest) throw new ToolError("rejected");
  await downloadSelected({
    manifest,
    paths,
    fetchHash: ctx.fetchHash,
    blobs: ctx.blobs,
    output: ctx.output,
    db: ctx.db,
    eventId,
    now: clock(ctx, record),
  });
  return { value: { eventId, paths }, eventIds: [eventId] };
}

async function membersTool(ctx: ToolContext, input: unknown): Promise<Done> {
  const members = await listMembers(ctx.db, requiredString(asRecord(input), "clubId"));
  return {
    value: {
      members: members.map((member) => ({
        publicKey: member.publicKey,
        role: member.role,
        joinedAt: member.joinedAt,
      })),
    },
    eventIds: [],
  };
}

async function learn(ctx: ToolContext, eventId: string, now: string): Promise<void> {
  try {
    const message = await readMessage(ctx.db, ctx.author.privateKey, eventId);
    if (!message.body) return;
    await bumpThemeWeights(ctx.db, matchingThemeIds(message.body, await listThemes(ctx.db)), now);
  } catch (error) {
    if (!(error instanceof MessageError)) throw error;
  }
}

async function recordAudit(
  ctx: ToolContext,
  time: string,
  name: string,
  eventIds: readonly string[],
  resultCode: string,
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO audit_log (time, tool, public_key, event_ids, result_code) VALUES (?, ?, ?, ?, ?)`,
    [time, TOOL_NAME.test(name) ? name : "unknown", ctx.author.publicKey, JSON.stringify(eventIds), resultCode],
  );
}

function resultCodeOf(error: unknown): string {
  if (error instanceof MessageError || error instanceof ToolError) return error.code;
  return "rejected";
}

function clock(ctx: ToolContext, record: Record<string, unknown>): string {
  const supplied = optionalString(record, "now");
  return supplied ?? ctx.now();
}

function asRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ToolError("rejected");
  return input as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new ToolError("rejected");
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  if (!(key in record) || record[key] === undefined || record[key] === null) return undefined;
  const value = record[key];
  if (typeof value !== "string") throw new ToolError("rejected");
  return value.length === 0 ? undefined : value;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ToolError("rejected");
  }
  return value;
}
