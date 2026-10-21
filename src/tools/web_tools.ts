import TurndownService from "turndown";
import { Tool, ToolContext, ToolResult } from "./types.js";


const DEFAULT_MAX_CHARS = 20000;
const HARD_MAX_CHARS = 50000;
const FETCH_TIMEOUT_MS = 20000;
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const USER_AGENT = "Zola/1.0 (+https://github.com/vinay-d07/arnim-zola)";

const turnDownInstance = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-'
})
turnDownInstance.remove(['script', 'style', 'noscript', 'iframe', 'nav', 'footer', 'form', 'button']);

const TEXT_CONTENT_TYPES = [
    "text/plain",
    "text/markdown",
    "text/x-markdown",
    "text/csv",
    "application/json",
    "application/xml",
    "text/xml",
    "application/javascript",
    "text/javascript",
];


function isHtml(contentType: string): boolean {
    return contentType.includes("text/html") || contentType.includes("application/xhtml");
}

function isText(contentType: string): boolean {
    // Some servers (raw.githubusercontent.com among them) send no content-type for plain files
    if (!contentType) return true;
    return TEXT_CONTENT_TYPES.some((t) => contentType.includes(t));
}

export function htmlToMarkdown(html: string): string {
    // Prefer the main content area when the page marks one, to skip sidebars and headers
    const mainMatch =
        html.match(/<main[\s>][\s\S]*?<\/main>/i) ?? html.match(/<article[\s>][\s\S]*?<\/article>/i);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

    let markdown = turnDownInstance.turndown(mainMatch ? mainMatch[0] : html);
    markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

    const title = titleMatch?.[1].trim();
    return title && !markdown.startsWith("# ") ? `# ${title}\n\n${markdown}` : markdown;
}


/// takes the response from the tool call and returns the content of the page
export async function readBodywithLimit(response: Response): Promise<{ text: string, tooLarge: boolean }> {

    if (!response.body) return { text: await response.text(), tooLarge: false };

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let tot = 0;
    while (true) {
        const { done, value } = await reader.read()
        if (done) break;
        tot += value.length;
        if (tot > MAX_DOWNLOAD_BYTES) {
            reader.cancel();
            return { text: "", tooLarge: true }
        }
        chunks.push(value);
    }


    return { text: Buffer.concat(chunks).toString("utf-8"), tooLarge: false };
}

export const webFetchTool: Tool = {
    name: "web_fetch",
    description: "Fetch a web page or file over HTTP(S) and return its content as markdown (HTML is converted; plain text and JSON are returned as is). Use this to read documentation, changelogs, READMEs, or API references. Long pages are cut off; call again with 'start_index' to read the next chunk.",
    requiresConfirmation: true,
    parameters: {
        type: "object",
        properties: {
            url: {
                type: "string",
                description: "The URL to fetch.",
            },
            start_index: {
                type: "number",
                description: "The starting index of the content to fetch.",
            },
        },
        required: ["url"],
    },
    execute: async function (params: { url: string; max_chars?: number; start_index?: number }, context: ToolContext): Promise<ToolResult> {


        try {

            let url: URL
            // build url
            try {
                url = new URL(params.url)
            } catch {
                return {
                    success: false,
                    output: `Invalid URL: '${params.url}'. Provide a full URL such as https://example.com/docs.`,
                    error: "INVALID URL"
                }
            }
            //Check whether the protocol is http or https
            if (url.protocol !== "http:" && url.protocol !== "https:") {
                return {
                    success: false,
                    output: `Unsupported URL scheme '${url.protocol}'. Only http:// and https:// URLs can be fetched.`,
                    error: "Unsupported scheme",
                };
            }
            // Confirm with user if not auto approved
            if (context.onConfirm && !context.autoApprove) {
                const ok = await context.onConfirm(`Fetch URL:\n  ${url.href}`);
                if (!ok) {
                    return {
                        success: false,
                        output: `User denied permission to fetch '${url.href}'.`,
                        error: "User denied permission",
                    };
                }
            }

            const maxChars = Math.min(HARD_MAX_CHARS, Math.max(1000, params.max_chars ?? DEFAULT_MAX_CHARS));
            const startIndex = Math.max(0, params.start_index ?? 0);

            // ACTUAL FETCHING 
            let resp: Response
            try {
                resp = await fetch(url, {
                    headers: {
                        "User-Agent": USER_AGENT,
                        "Accept": "text/html,application/xhtml+xml,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5",
                    },
                    redirect: "follow",
                    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
                })
            } catch (err: any) {
                const reason = err.name === "TimeoutError" ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s` : err.message;
                return {
                    success: false,
                    output: `Failed to fetch '${url.href}': ${reason}`,
                    error: reason,
                };
            }



            // NON OK responses
            if (!resp.ok) {
                return {
                    success: false,
                    output: `Fetch failed: ${url.href} returned HTTP ${resp.status} ${resp.statusText}.`,
                    error: `HTTP ${resp.status}`,
                    metadata: { status: resp.status },
                };
            }
            const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
            if (!isHtml(contentType) && !isText(contentType)) {
                await resp.body?.cancel();
                return {
                    success: false,
                    output: `Cannot read '${url.href}': content type '${contentType}' is not text or HTML.`,
                    error: "Unsupported content type",
                };
            }

            const { text, tooLarge } = await readBodywithLimit(resp);
            if (tooLarge) {
                return {
                    success: false,
                    output: `Cannot read '${url.href}': response is larger than ${MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB.`,
                    error: "Response too large",
                };
            }
            const fullContent = isHtml(contentType) ? htmlToMarkdown(text) : text.trim();

            if (startIndex >= fullContent.length && fullContent.length > 0) {
                return {
                    success: false,
                    output: `start_index ${startIndex} is past the end of the content (${fullContent.length} chars).`,
                    error: "start_index out of range",
                };
            }

            const chunk = fullContent.slice(startIndex, startIndex + maxChars);
            const endIndex = startIndex + chunk.length;
            const hasMore = endIndex < fullContent.length;

            const header = `Content from ${resp.url} (chars ${startIndex}-${endIndex} of ${fullContent.length}):\n\n`;
            const footer = hasMore
                ? `\n\n... [Content truncated. Call web_fetch again with start_index=${endIndex} to read more.]`
                : "";

            return {
                success: true,
                output: header + (chunk || "(empty page)") + footer,
                metadata: {
                    finalUrl: resp.url,
                    contentType,
                    totalChars: fullContent.length,
                    hasMore,
                },
            };
        } catch (err: any) {
            return {
                success: false,
                output: `Web fetch failed: ${err.message}`,
                error: err.message,
            };
        }
    },
};
