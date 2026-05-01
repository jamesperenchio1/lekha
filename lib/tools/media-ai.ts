import { z } from "zod";
import { tool } from "ai";
import { generateText } from "ai";
import { extractorModel } from "@/lib/llm/provider";
import { listRecentMedia } from "@/lib/memory/recent-media";
import { getMessageContent } from "@/lib/line/client";

/**
 * Tools that use Gemini's multimodal capabilities on staged LINE files.
 * Each picks one staged item by 1-indexed position (default: most recent matching kind).
 */
export function buildMediaAiTools(userId: string) {
  return {
    transcribe_audio: tool({
      description:
        "Transcribe a voice memo / audio file the user sent in LINE. Defaults to the most recent audio. Returns plain text.",
      inputSchema: z.object({
        index: z.number().int().min(1).optional().describe("1-indexed staged position. Omit for most-recent audio."),
      }),
      execute: async ({ index }) =>
        runMediaPrompt(userId, index, "audio", "Transcribe this audio verbatim. Do not summarize. Output only the transcript text."),
    }),

    summarize_audio: tool({
      description:
        "Summarize the contents of a voice memo or audio file the user sent in LINE.",
      inputSchema: z.object({ index: z.number().int().min(1).optional() }),
      execute: async ({ index }) =>
        runMediaPrompt(userId, index, "audio", "Summarize this audio in 2-4 sentences. Capture the key points and action items if any."),
    }),

    ocr_image: tool({
      description:
        "Extract all readable text from an image the user sent in LINE (receipts, signs, screenshots, handwriting). Returns the verbatim text.",
      inputSchema: z.object({ index: z.number().int().min(1).optional() }),
      execute: async ({ index }) =>
        runMediaPrompt(userId, index, "image", "Read all text in this image and output it verbatim. Preserve line breaks. If there is no text, say 'No text detected.' If multiple columns or sections, separate them with blank lines."),
    }),

    summarize_image: tool({
      description:
        "Describe what's in an image the user sent (people, scene, objects, what they might want).",
      inputSchema: z.object({ index: z.number().int().min(1).optional() }),
      execute: async ({ index }) =>
        runMediaPrompt(userId, index, "image", "Describe this image in 2-4 sentences. Note people, objects, setting, and anything actionable."),
    }),

    summarize_document: tool({
      description:
        "Summarize a PDF or other document the user sent as a LINE file. Works on PDFs natively via Gemini's PDF understanding.",
      inputSchema: z.object({ index: z.number().int().min(1).optional() }),
      execute: async ({ index }) =>
        runMediaPrompt(userId, index, "file", "Summarize this document in 4-8 bullets. Highlight: purpose, key facts, dates, names, action items, conclusion."),
    }),
  };
}

async function runMediaPrompt(
  userId: string,
  index: number | undefined,
  expectedKind: "audio" | "image" | "video" | "file",
  instruction: string,
) {
  const staged = await listRecentMedia(userId);
  if (!staged.length) {
    return { ok: false as const, error: "No staged LINE media. Send the file first." };
  }
  const item = (() => {
    if (index !== undefined) {
      if (index < 1 || index > staged.length) return null;
      return staged[index - 1];
    }
    // Default: most recent of the expected kind, fallback to most recent overall.
    for (let i = staged.length - 1; i >= 0; i--) {
      if (staged[i]!.kind === expectedKind) return staged[i];
    }
    return staged[staged.length - 1];
  })();
  if (!item) return { ok: false as const, error: "Index out of range" };

  let bytes: Uint8Array;
  let mediaType: string;
  try {
    const fetched = await getMessageContent(item.messageId);
    bytes = fetched.bytes;
    mediaType = fetched.contentType;
  } catch (err) {
    return {
      ok: false as const,
      error: `Couldn't fetch file from LINE: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const r = await generateText({
      model: extractorModel(),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            { type: "file", data: bytes, mediaType },
          ],
        },
      ],
    });
    return { ok: true as const, kind: item.kind, mediaType, output: r.text.trim() };
  } catch (err) {
    return {
      ok: false as const,
      error: `Gemini call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
