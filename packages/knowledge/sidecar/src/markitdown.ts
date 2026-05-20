/**
 * MarkItDown integration for converting binary documents to Markdown.
 * Requires Python 3.10+ and `pip install markitdown` on the system.
 * Gracefully degrades when not available — binary files are simply skipped.
 */

interface DetectResult {
  available: boolean
  pythonPath: string
  version?: string
  error?: string
}

let cachedDetection: DetectResult | null = null

/**
 * Detect whether Python + markitdown are available on the system.
 * Result is cached for the process lifetime.
 */
export async function detectMarkItDown(): Promise<DetectResult> {
  if (cachedDetection) return cachedDetection

  for (const pythonCmd of ["python3", "python"]) {
    try {
      const proc = Bun.spawn([pythonCmd, "-c", "import markitdown; print(markitdown.__version__)"], {
        stdout: "pipe",
        stderr: "pipe",
      })

      const exitCode = await proc.exited
      if (exitCode === 0) {
        const version = (await new Response(proc.stdout).text()).trim()
        cachedDetection = { available: true, pythonPath: pythonCmd, version }
        console.log(`[markitdown] Detected: ${pythonCmd} with markitdown v${version}`)
        return cachedDetection
      }
    } catch {
      // Try next python command
    }
  }

  cachedDetection = {
    available: false,
    pythonPath: "",
    error: "Python or markitdown not found. Install with: pip install markitdown",
  }
  console.log(`[markitdown] Not available: ${cachedDetection.error}`)
  return cachedDetection
}

const CONVERT_TIMEOUT = 30_000 // 30 seconds per file

/**
 * Convert a binary document (PDF, docx, etc.) to Markdown using markitdown CLI.
 * Returns the converted content or an empty result on failure.
 */
export async function convertToMarkdown(filePath: string): Promise<{ content: string; success: boolean }> {
  const detection = await detectMarkItDown()
  if (!detection.available) {
    return { content: "", success: false }
  }

  try {
    const proc = Bun.spawn([detection.pythonPath, "-m", "markitdown", filePath], {
      stdout: "pipe",
      stderr: "pipe",
    })

    // Timeout handling
    const timeout = setTimeout(() => {
      try { proc.kill() } catch { /* ignore */ }
    }, CONVERT_TIMEOUT)

    const exitCode = await proc.exited
    clearTimeout(timeout)

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      console.error(`[markitdown] Conversion failed for ${filePath}: exit ${exitCode}, ${stderr.slice(0, 200)}`)
      return { content: "", success: false }
    }

    const content = await new Response(proc.stdout).text()
    if (!content.trim()) {
      console.warn(`[markitdown] Empty output for ${filePath}`)
      return { content: "", success: false }
    }

    return { content, success: true }
  } catch (err) {
    console.error(`[markitdown] Error converting ${filePath}:`, err)
    return { content: "", success: false }
  }
}
