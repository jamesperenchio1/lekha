import { z } from "zod";

const Source = z.object({
  type: z.enum(["user", "group", "room"]),
  userId: z.string().optional(),
  groupId: z.string().optional(),
  roomId: z.string().optional(),
});

const TextMessage = z.object({
  type: z.literal("text"),
  id: z.string(),
  text: z.string(),
});

const ImageMessage = z.object({
  type: z.literal("image"),
  id: z.string(),
  contentProvider: z.object({ type: z.string() }).optional(),
});

const VideoMessage = z.object({
  type: z.literal("video"),
  id: z.string(),
  duration: z.number().optional(),
  contentProvider: z.object({ type: z.string() }).optional(),
});

const AudioMessage = z.object({
  type: z.literal("audio"),
  id: z.string(),
  duration: z.number().optional(),
  contentProvider: z.object({ type: z.string() }).optional(),
});

const FileMessage = z.object({
  type: z.literal("file"),
  id: z.string(),
  fileName: z.string().optional(),
  fileSize: z.number().optional(),
});

const StickerMessage = z.object({
  type: z.literal("sticker"),
  id: z.string(),
  packageId: z.string(),
  stickerId: z.string(),
});

const OtherMessage = z.object({
  type: z.string(),
  id: z.string().optional(),
});

const Message = z.union([
  TextMessage,
  ImageMessage,
  VideoMessage,
  AudioMessage,
  FileMessage,
  StickerMessage,
  OtherMessage,
]);

export const MessageEvent = z.object({
  type: z.literal("message"),
  webhookEventId: z.string(),
  timestamp: z.number(),
  source: Source,
  replyToken: z.string(),
  message: Message,
  mode: z.string().optional(),
});

export const FollowEvent = z.object({
  type: z.literal("follow"),
  webhookEventId: z.string(),
  timestamp: z.number(),
  source: Source,
  replyToken: z.string(),
});

export const UnfollowEvent = z.object({
  type: z.literal("unfollow"),
  webhookEventId: z.string(),
  timestamp: z.number(),
  source: Source,
});

export const OtherEvent = z.object({
  type: z.string(),
  webhookEventId: z.string().optional(),
  timestamp: z.number().optional(),
  source: Source.optional(),
});

export const LineEvent = z.union([MessageEvent, FollowEvent, UnfollowEvent, OtherEvent]);
export type LineEvent = z.infer<typeof LineEvent>;

export const Webhook = z.object({
  destination: z.string(),
  events: z.array(LineEvent),
});
