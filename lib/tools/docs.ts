import { z } from "zod";
import { tool } from "ai";
import { google } from "googleapis";
import { withGoogleClient } from "./with-google";

const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
const SLIDES_SCOPE = "https://www.googleapis.com/auth/presentations";

export function buildDocsTools(userId: string) {
  return {
    create_google_doc: tool({
      description:
        "Create a new Google Doc with a title and plain-text body. Returns the Drive link. Example: create_google_doc('Meeting Notes May 4', 'Agenda:\\n- Budget\\n- Roadmap'). Use drive_read_text to read an existing doc before editing it.",
      inputSchema: z.object({
        title: z.string().min(1).max(200).describe("Document title"),
        body: z.string().max(50_000).describe("Plain text content to insert into the document body"),
        fromEmail: z.string().email().optional().describe("Which Google account to use (omit for active)"),
      }),
      execute: async ({ title, body, fromEmail }) => {
        const result = await withGoogleClient(userId, fromEmail, [DOCS_SCOPE], async ({ client }) => {
          const docs = google.docs({ version: "v1", auth: client });
          const created = await docs.documents.create({ requestBody: { title } });
          const documentId = created.data.documentId!;
          if (body.trim()) {
            await docs.documents.batchUpdate({
              documentId,
              requestBody: {
                requests: [{ insertText: { text: body, location: { index: 1 } } }],
              },
            });
          }
          return {
            ok: true as const,
            fileId: documentId,
            title,
            url: `https://docs.google.com/document/d/${documentId}/edit`,
          };
        });
        return result;
      },
    }),

    edit_google_doc: tool({
      description:
        "Replace the entire body of an existing Google Doc with new content. IMPORTANT: First call drive_read_text(fileId) to get the current text, then decide what the new full text should be, then call edit_google_doc with the complete replacement. Do not call this blindly — always read first.",
      inputSchema: z.object({
        fileId: z.string().min(1).describe("Google Doc file ID (from drive_search or a previous create_google_doc)"),
        newContent: z.string().max(50_000).describe("The complete new text for the document body (replaces existing content)"),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ fileId, newContent, fromEmail }) => {
        const result = await withGoogleClient(userId, fromEmail, [DOCS_SCOPE], async ({ client }) => {
          const docs = google.docs({ version: "v1", auth: client });
          // Get current doc to find body end index
          const doc = await docs.documents.get({ documentId: fileId });
          const bodyContent = doc.data.body?.content ?? [];
          const lastSegment = bodyContent[bodyContent.length - 1];
          const endIndex = lastSegment?.endIndex ?? 1;
          const charsBefore = Math.max(0, endIndex - 1);

          const requests: object[] = [];
          // Delete all existing body content (index 1 to endIndex-1), leaving the required trailing newline.
          if (endIndex > 2) {
            requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
          }
          // Insert new content at index 1
          if (newContent.trim()) {
            requests.push({ insertText: { text: newContent, location: { index: 1 } } });
          }

          if (requests.length) {
            await docs.documents.batchUpdate({ documentId: fileId, requestBody: { requests } });
          }

          return {
            ok: true as const,
            fileId,
            url: `https://docs.google.com/document/d/${fileId}/edit`,
            charsBefore,
            charsAfter: newContent.length,
          };
        });
        return result;
      },
    }),

    create_google_slide: tool({
      description:
        "Create a new Google Slides presentation from structured bullet-point slides. Each slide has a heading and bullet points. Returns the presentation link. Example: create_google_slide('Q1 Review', [{heading: 'Revenue', bullets: ['Up 20%', 'New deals: 5']}]).",
      inputSchema: z.object({
        title: z.string().min(1).max(200).describe("Presentation title"),
        slides: z
          .array(
            z.object({
              heading: z.string().max(200).describe("Slide title / heading"),
              bullets: z.array(z.string().max(300)).max(10).describe("Bullet points for the slide body"),
            }),
          )
          .min(1)
          .max(20)
          .describe("Array of slides — each has a heading and bullet list"),
        fromEmail: z.string().email().optional(),
      }),
      execute: async ({ title, slides: slideDefs, fromEmail }) => {
        const result = await withGoogleClient(userId, fromEmail, [SLIDES_SCOPE], async ({ client }) => {
          const slides = google.slides({ version: "v1", auth: client });

          // 1. Create the presentation (comes with 1 auto-generated blank slide)
          const created = await slides.presentations.create({ requestBody: { title } });
          const presentationId = created.data.presentationId!;
          const firstSlideId = created.data.slides?.[0]?.objectId;

          // 2. Add one TITLE_AND_BODY slide per definition, then delete the initial blank slide
          const addRequests: object[] = slideDefs.map(() => ({
            addSlide: { slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" } },
          }));
          if (firstSlideId) {
            addRequests.push({ deleteObject: { objectId: firstSlideId } });
          }
          await slides.presentations.batchUpdate({
            presentationId,
            requestBody: { requests: addRequests },
          });

          // 3. Read the presentation to find placeholder IDs
          const full = await slides.presentations.get({ presentationId });
          const insertRequests: object[] = [];
          const addedSlides = full.data.slides ?? [];

          for (let i = 0; i < slideDefs.length && i < addedSlides.length; i++) {
            const slide = addedSlides[i]!;
            const def = slideDefs[i]!;
            for (const el of slide.pageElements ?? []) {
              const pt = el.shape?.placeholder?.type;
              if ((pt === "CENTERED_TITLE" || pt === "TITLE") && el.objectId) {
                insertRequests.push({
                  insertText: { objectId: el.objectId, text: def.heading, insertionIndex: 0 },
                });
              } else if (pt === "BODY" && el.objectId) {
                insertRequests.push({
                  insertText: {
                    objectId: el.objectId,
                    text: def.bullets.join("\n"),
                    insertionIndex: 0,
                  },
                });
              }
            }
          }

          // 4. Insert all text in one batch
          if (insertRequests.length) {
            await slides.presentations.batchUpdate({
              presentationId,
              requestBody: { requests: insertRequests },
            });
          }

          return {
            ok: true as const,
            fileId: presentationId,
            title,
            slideCount: slideDefs.length,
            url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
          };
        });
        return result;
      },
    }),
  };
}
