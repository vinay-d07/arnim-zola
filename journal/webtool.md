# Developer Journal: Building the Web Fetch Tool

I'm starting to write these entries because I've realized how easy it is to forget *why* I made certain decisions once the code is committed. Documenting my thought process as I build is something I want to make a habit of.

---

## What I Built Today
Today, I built the **Web Fetch** tool. 

The main goal was simple: give our coding assistant the ability to reach out to the internet and read web pages—like official documentation, library changelogs, or GitHub READMEs. When libraries get updated, models often get stuck on old training data, so giving it a way to read current docs solves a huge problem.

---

## How It Works (In Plain English)

Building a web fetcher sounds straightforward at first—just grab a URL and return the text. But in practice, the web is messy. If you don't add guardrails, things break fast. Here is how I structured it:

1. **Safety and Sanity Checks**
   - **Valid Links Only:** Before doing anything, it checks if the URL is properly formatted and only uses `http://` or `https://`. It blocks local file paths (like `file://`) to avoid accidental security risks.
   - **User Permission:** It respects user control. Unless auto-approve is turned on, it pauses and asks the user: *"Hey, is it okay if I visit this link?"*

2. **Fetching & Protecting Against Huge Downloads**
   - **Timeouts:** Set a sensible timeout so the tool never freezes waiting on a slow or dead server.
   - **Size Limits:** Before downloading an entire page, it streams the response and stops immediately if it exceeds 5 MB. This prevents memory leaks and avoids freezing the system on huge downloads.
   - **Text Only:** It checks the content type first. If someone passes an image, video, or zip file, it politely cancels instead of wasting resources trying to read binary data.

3. **Cleaning Up the Clutter (HTML to Markdown)**
   - Webpages are full of junk: navigation bars, footers, scripts, and advertisements. 
   - I used a markdown converter to extract the real content (targeting the `<main>` or `<article>` tags when present) and convert headings, code blocks, and lists into clean, readable markdown.

4. **Chunking Long Pages**
   - AI models get overwhelmed if you dump tens of thousands of characters at once.
   - If a documentation page is massive, the tool serves a clean, manageable chunk and leaves a bookmark: *"Here is part 1. If you need more, call back with `start_index` to read the next section."*

---

## Thoughts & Takeaways
The most satisfying part of today was seeing all unit tests pass—covering everything from title extraction and markdown formatting to handling user denial and rejecting unsupported files. 

Taking the time to think about edge cases (like runaway file sizes, timeouts, and user privacy) turned what could have been a fragile 10-line fetch script into a reliable, safe tool. Excited to see it in action!
