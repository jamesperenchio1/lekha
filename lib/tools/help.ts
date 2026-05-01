import { z } from "zod";
import { tool } from "ai";

const HELP_TEXT = `Here's what I can do:

📝 *Memory*
- "remember that I prefer espresso"
- "what do you remember about me"
- "forget that I'm in Bangkok" / "edit memory #3 to say…"

⏰ *Reminders*
- "remind me in 5 min to stretch"
- "remind me every weekday at 8am to take vitamins"
- "list my reminders" / "cancel that 8am reminder"

📋 *Tasks* (persist until done)
- "add a task to ship the cert PDF"
- "list my open tasks"
- "mark task #3 done"

📧 *Email* (after connecting Google)
- "email mom the receipt" — looks up Mom in your Contacts
- "draft to bob@x.com cc'ing alice with the cert PDF attached"
- "summarize today's inbox"
- "reply to bob's last email saying I'll be there"
- "send this on Monday at 9 AM"

📅 *Calendar*
- "schedule lunch with Ana tomorrow at noon"
- "what's on my calendar today"
- "any conflicts before I add this"

📁 *Drive*
- "search my drive for q3"
- "save this PDF to my Drive"
- "read me that doc"

📷 *Media*
- Send any photo / video / audio / file → I keep it for ~30 min
- "email all of those to bob" — attaches the staged files
- "what's in this photo" — vision Q&A
- "transcribe this voice memo" — audio transcription
- "extract the text from this image" — OCR

🌍 *Settings*
- "set my timezone to Asia/Bangkok"
- "set my location to Bangkok, Thailand"
- "send me a daily briefing at 7am"
- "remind me 15 min before each meeting"

🔌 *Google accounts*
- "list my google accounts"
- "connect another google account"
- "use my work account"

🛠 *Power-user*
- "what did I send to bob today"
- "search my old conversations for X"
- "export all my data"`;

export function buildHelpTools() {
  return {
    show_help: tool({
      description:
        "Show the user a concise list of all current capabilities. Call this when the user asks 'what can you do', 'help', 'how do I…', '/help', or seems lost.",
      inputSchema: z.object({}),
      execute: async () => ({ help: HELP_TEXT }),
    }),
  };
}

export { HELP_TEXT };
