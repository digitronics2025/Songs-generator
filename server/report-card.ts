/**
 * Report card builder — the ONE way a bot builds a message for the Digitronics
 * Messenger (owner, 01/11/2026: "help me scan quick" — charts first, few words).
 *
 * CANONICAL COPY: digitronics2025/whatsapp-inbox-saas
 *   packages/shared/src/report-card.ts
 * Other apps keep a VERBATIM copy (DigiTronics.ma, tenten-accounting-in,
 * sales-analyzer). It has no imports on purpose so it can be copied as-is;
 * change it here first, then copy it everywhere (FLEET.md lists the copies).
 * Format rules: whatsapp-inbox-saas docs/systems/direct-messages.md
 * "Bot report cards" and the `report-cards` skill.
 *
 * One builder call produces BOTH outputs, so they can never disagree:
 *  - `blocks`: what the Messenger draws (headline, one picture, options, chips);
 *  - `body`:   the complete plain text — push notifications, the chat list,
 *              Telegram and old app versions read this. Marks are stripped.
 *
 * Marks inside text, one meaning each: *fact* bold · _guess_ italic ·
 * __deadline__ underline · ~replaced figure~ strike. Word edges only.
 *
 * `build()` enforces the house rules and throws on a break, so a card that
 * would be hard to scan never ships: at most ONE picture (bars, meter,
 * timeline, change), at most four tiles, at most 20 blocks.
 */

export type CardTone = "neutral" | "good" | "warn" | "critical"
export type CardFactKind = "next" | "prepared" | "who" | "why" | "source" | "mode" | "when"

export interface CardListItem {
  title: string
  value?: string
  detail?: string
  tone?: CardTone
  tag?: string
  bar?: { value: number; max: number }
}

export type CardBlock =
  | { type: "header"; text: string }
  | { type: "lead"; text: string }
  | { type: "callout"; text: string; tone?: CardTone; label?: string; confidence?: string }
  | {
      type: "stats"
      title?: string
      layout?: "rows" | "tiles"
      items: Array<{
        label: string
        value: string
        unit?: string
        tone?: CardTone
        delta?: { dir: "up" | "down"; text: string }
        note?: string
      }>
    }
  | {
      type: "bars"
      title?: string
      scale?: "zero" | "diverging"
      items: Array<{ label: string; value: number; display: string; tone?: CardTone; ghost?: number }>
      ghostLabel?: string
    }
  | { type: "meter"; label: string; value: number; max: number; display?: string; tone?: CardTone; caption?: string }
  | {
      type: "timeline"
      title?: string
      items: Array<{ date: string; label: string; detail?: string; tone?: CardTone; state?: "done" | "next" | "later" }>
    }
  | { type: "list"; title?: string; items: CardListItem[] }
  | {
      type: "table"
      title?: string
      columns: Array<{ label: string; align?: "start" | "end" }>
      rows: Array<{ cells: Array<{ text: string; tone?: CardTone }> }>
      rowsOmitted?: number
    }
  | { type: "options"; title?: string; items: Array<{ text: string; consequence?: string }> }
  | { type: "facts"; items: Array<{ kind?: CardFactKind; label: string; text: string; at?: string }> }
  | { type: "details"; summary: string; text?: string; items?: CardListItem[] }
  | { type: "change"; label?: string; steps: string[]; from: string; to: string; skipped?: string[] }
  | { type: "quote"; text: string; by?: string }
  | { type: "note"; text: string }
  | { type: "actions"; buttons: Array<{ label: string; url: string }> }

export interface ReportCard {
  /** Complete plain text (≤ 2000 characters), marks removed. */
  body: string
  /** Messenger blocks, drawn instead of the body when present. */
  blocks: CardBlock[]
}

const PICTURES = new Set(["bars", "meter", "timeline", "change"])
const MAX_BLOCKS = 20
const MAX_TILES = 4
const BODY_MAX = 2000

const MARK_RE =
  /(^|[\s([{«"'‘“—–·/])(__(?=\S)([^_]*?\S)__|\*(?=\S)([^*]*?\S)\*|_(?=\S)([^_]*?\S)_|~(?=\S)([^~]*?\S)~)(?=$|[\s)\]}»"'’”.,;:!?—–·/])/gu

/** The words without the marks — what push, previews and Telegram show. */
export function stripCardMarks(text: string): string {
  return text.replace(MARK_RE, (_all, pre: string, _m, u?: string, b?: string, i?: string, s?: string) => {
    return pre + (u ?? b ?? i ?? s ?? "")
  })
}

const plainLine = (text: string) => stripCardMarks(text).replace(/\s+/g, " ").trim()

function bodyLines(block: CardBlock): string[] {
  switch (block.type) {
    case "header":
      return ["", block.text]
    case "lead":
    case "note":
      return [plainLine(block.text)]
    case "callout":
      return [block.label ? `${block.label}: ${plainLine(block.text)}` : plainLine(block.text)]
    case "stats":
      return [
        ...(block.title ? [block.title] : []),
        ...block.items.map((i) => {
          const delta = i.delta ? ` (${i.delta.dir === "down" ? "▼" : "▲"} ${i.delta.text})` : ""
          return `${i.label}: ${i.value}${i.unit ? ` ${i.unit}` : ""}${delta}`
        }),
      ]
    case "bars":
      return [...(block.title ? [block.title] : []), ...block.items.map((i) => `• ${i.label}: ${i.display}`)]
    case "meter":
      return [`${block.label}: ${block.display ?? `${block.value}/${block.max}`}`]
    case "timeline":
      return [
        ...(block.title ? [block.title] : []),
        ...block.items.map((i) => `• ${i.date} — ${plainLine(i.label)}${i.detail ? ` (${plainLine(i.detail)})` : ""}`),
      ]
    case "list":
      return [...(block.title ? [block.title] : []), ...listLines(block.items)]
    case "table":
      return [
        ...(block.title ? [block.title] : []),
        block.columns.map((c) => c.label).join(" | "),
        ...block.rows.map((r) => r.cells.map((c) => c.text).join(" | ")),
      ]
    case "options":
      return [`${block.title ?? "Your options"}: ${block.items.map((o, n) => `(${n + 1}) ${plainLine(o.text)}`).join("; ")}`]
    case "facts":
      return block.items.map((f) => `${f.label}: ${plainLine(f.text)}`)
    case "details":
      return [
        ...(block.text ? [`${block.summary}: ${plainLine(block.text)}`] : [block.summary]),
        ...(block.items ? listLines(block.items) : []),
      ]
    case "change":
      return [`${block.label ?? "Changed"}: ${block.from} → ${block.to}`]
    case "quote":
      return [`“${block.text}”${block.by ? ` — ${block.by}` : ""}`]
    case "actions":
      return block.buttons.map((b) => `${b.label}: ${b.url}`)
  }
}

function listLines(items: CardListItem[]): string[] {
  return items.map((i) => {
    const tag = i.tag ? `[${i.tag}] ` : ""
    const detail = i.detail ? ` ${plainLine(i.detail)}` : ""
    return `• ${tag}${plainLine(i.title)}${detail}${i.value ? ` — ${i.value}` : ""}`
  })
}

/** Builds the plain body from blocks; used by `build()` and exported for tests. */
export function cardBody(blocks: CardBlock[]): string {
  const text = blocks
    .flatMap(bodyLines)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1).trimEnd()}…` : text
}

/** Throws when a card breaks a house rule; returns the blocks unchanged otherwise. */
export function checkCardBlocks(blocks: CardBlock[]): CardBlock[] {
  if (blocks.length === 0) throw new Error("report card: no blocks")
  if (blocks.length > MAX_BLOCKS) throw new Error(`report card: at most ${MAX_BLOCKS} blocks`)
  const pictures = blocks.filter((b) => PICTURES.has(b.type)).length
  if (pictures > 1) throw new Error("report card: one picture per card (bars, meter, timeline or change)")
  for (const b of blocks) {
    if (b.type === "stats" && b.layout === "tiles" && b.items.length > MAX_TILES) {
      throw new Error(`report card: at most ${MAX_TILES} tiles`)
    }
    if (b.type === "bars" || b.type === "meter") {
      const nums = b.type === "bars" ? b.items.flatMap((i) => [i.value, i.ghost ?? 0]) : [b.value, b.max]
      if (nums.some((n) => !Number.isFinite(n))) throw new Error(`report card: ${b.type} needs finite numbers`)
    }
  }
  return blocks
}

/**
 * Fluent builder. Order of calls = order on screen. Recommended order:
 * why → lead → one picture → wrong → options → risk → prepared / who / next → source.
 */
export class ReportCardBuilder {
  private readonly blocks: CardBlock[] = []
  private readonly footer: Array<{ kind?: CardFactKind; label: string; text: string; at?: string }> = []

  /** Small tag under the title: why this matters ("Money · orders and sales"). */
  why(text: string, label = "Why"): this {
    this.blocks.push({ type: "facts", items: [{ kind: "why", label, text }] })
    return this
  }
  /** The one sentence to read if you read nothing else. Figures in *bold*. */
  lead(text: string): this {
    this.blocks.push({ type: "lead", text })
    return this
  }
  section(text: string): this {
    this.blocks.push({ type: "header", text })
    return this
  }
  /** Two to four big numbers. */
  tiles(items: Extract<CardBlock, { type: "stats" }>["items"], title?: string): this {
    this.blocks.push({ type: "stats", layout: "tiles", items, ...(title ? { title } : {}) })
    return this
  }
  /** Label/value rows, for more than four figures. */
  rows(items: Extract<CardBlock, { type: "stats" }>["items"], title?: string): this {
    this.blocks.push({ type: "stats", items, ...(title ? { title } : {}) })
    return this
  }
  /** Compare a few values; `ghost` draws the earlier value dashed. */
  bars(
    title: string,
    items: Extract<CardBlock, { type: "bars" }>["items"],
    opts: { diverging?: boolean; ghostLabel?: string } = {},
  ): this {
    this.blocks.push({
      type: "bars",
      title,
      items,
      ...(opts.diverging ? { scale: "diverging" as const } : {}),
      ...(opts.ghostLabel ? { ghostLabel: opts.ghostLabel } : {}),
    })
    return this
  }
  /** X of N. */
  meter(label: string, value: number, max: number, opts: { display?: string; tone?: CardTone; caption?: string } = {}): this {
    this.blocks.push({ type: "meter", label, value, max, ...opts })
    return this
  }
  timeline(title: string, items: Extract<CardBlock, { type: "timeline" }>["items"]): this {
    this.blocks.push({ type: "timeline", title, items })
    return this
  }
  list(title: string, items: CardListItem[]): this {
    this.blocks.push({ type: "list", title, items })
    return this
  }
  table(title: string, columns: Extract<CardBlock, { type: "table" }>["columns"], rows: string[][], rowsOmitted?: number): this {
    this.blocks.push({
      type: "table",
      title,
      columns,
      rows: rows.map((r) => ({ cells: r.map((text) => ({ text })) })),
      ...(rowsOmitted ? { rowsOmitted } : {}),
    })
    return this
  }
  change(label: string, steps: string[], from: string, to: string, skipped: string[] = []): this {
    this.blocks.push({ type: "change", label, steps, from, to, ...(skipped.length ? { skipped } : {}) })
    return this
  }
  /** "What looks wrong" — guesses in _italic_; confidence only when you know it. */
  wrong(text: string, confidence?: string, label = "What looks wrong"): this {
    this.blocks.push({ type: "callout", tone: "warn", label, text, ...(confidence ? { confidence } : {}) })
    return this
  }
  callout(label: string, text: string, tone: CardTone = "neutral"): this {
    this.blocks.push({ type: "callout", tone, label, text })
    return this
  }
  /** Numbered choices, each starting with the action in *bold*. */
  options(items: Array<string | { text: string; consequence?: string }>, title = "Your options"): this {
    this.blocks.push({ type: "options", title, items: items.map((i) => (typeof i === "string" ? { text: i } : i)) })
    return this
  }
  /** "If nothing is done" — the cost, with the date in __underline__. */
  risk(text: string, label = "If nothing is done"): this {
    this.blocks.push({ type: "callout", tone: "critical", label, text })
    return this
  }
  quote(text: string, by?: string): this {
    this.blocks.push({ type: "quote", text, ...(by ? { by } : {}) })
    return this
  }
  note(text: string): this {
    this.blocks.push({ type: "note", text })
    return this
  }
  /** Footer chip; all footer chips render together as one row. */
  fact(kind: CardFactKind, label: string, text: string, at?: Date | string): this {
    this.footer.push({ kind, label, text, ...(at ? { at: typeof at === "string" ? at : at.toISOString() } : {}) })
    return this
  }
  prepared(text: string): this {
    return this.fact("prepared", "Prepared", text)
  }
  who(text: string): this {
    return this.fact("who", "Who acts", text)
  }
  /** When the next check runs; `at` lets the reader see it in their own clock. */
  next(text: string, at?: Date | string): this {
    return this.fact("next", "Next check", text, at)
  }
  /** Folded until tapped: where the figures came from. */
  source(text: string, summary = "Source"): this {
    this.blocks.push({ type: "details", summary, text })
    return this
  }
  details(summary: string, items: CardListItem[]): this {
    this.blocks.push({ type: "details", summary, items })
    return this
  }
  actions(buttons: Array<{ label: string; url: string }>): this {
    const safe = buttons.filter((b) => /^https:\/\//i.test(b.url)).slice(0, 3)
    if (safe.length > 0) this.blocks.push({ type: "actions", buttons: safe })
    return this
  }

  build(): ReportCard {
    const blocks = [...this.blocks]
    // The footer goes before folded details and buttons, after everything else.
    if (this.footer.length > 0) {
      const tail = blocks.findIndex((b) => b.type === "details" || b.type === "actions")
      const facts: CardBlock = { type: "facts", items: this.footer.slice(0, 6) }
      if (tail === -1) blocks.push(facts)
      else blocks.splice(tail, 0, facts)
    }
    checkCardBlocks(blocks)
    return { body: cardBody(blocks), blocks }
  }
}

export function reportCard(): ReportCardBuilder {
  return new ReportCardBuilder()
}
