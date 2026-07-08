/**
 * Brand icons for IM channels / office CLI connectors (WeChat, WeCom,
 * DingTalk, Feishu). Rendered as a brand-colored circular badge so all four
 * read consistently at small sizes in both light and dark themes.
 *
 * Glyph sources (all embedded at build time — no runtime fetch, Tauri offline):
 * - WeChat:   simple-icons `wechat` (CC0-1.0)
 * - WeCom:    TDesign Icons `logo-wecom-filled` (MIT, Tencent official)
 * - DingTalk: Remix Icon `dingding-fill` (Apache-2.0)
 * - Feishu:   Semi Design Icons `feishu_logo` (MIT, ByteDance official)
 *
 * Usage here is nominative (indicating interoperability with the named
 * services); the trademarks belong to their respective owners.
 */
import { cn } from "@/lib/utils"

type BrandIconProps = { className?: string }

/* Knockout-style glyphs (DingTalk/WeCom) carve the mark out of a filled disc,
 * so a white disc sits underneath to keep the mark white in dark mode too. */

const WECHAT_GLYPH =
  "M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213c0 .163.13.295.29.295a.33.33 0 0 0 .167-.054l1.903-1.114a.86.86 0 0 1 .717-.098a10.2 10.2 0 0 0 2.837.403c.276 0 .543-.027.811-.05c-.857-2.578.157-4.972 1.932-6.446c1.703-1.415 3.882-1.98 5.853-1.838c-.576-3.583-4.196-6.348-8.596-6.348M5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178a1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18m5.34 2.867c-1.797-.052-3.746.512-5.28 1.786c-1.72 1.428-2.687 3.72-1.78 6.22c.942 2.453 3.666 4.229 6.884 4.229c.826 0 1.622-.12 2.361-.336a.72.72 0 0 1 .598.082l1.584.926a.3.3 0 0 0 .14.047c.134 0 .24-.111.24-.247c0-.06-.023-.12-.038-.177l-.327-1.233a.6.6 0 0 1-.023-.156a.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983a.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983a.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982"

const FEISHU_GLYPH =
  "M6.13732 3.80654C8.76716 5.98777 11.0232 8.49408 12.7428 11.4327L14.4397 9.75535C15.2458 8.96545 16.2113 8.34129 17.258 7.93496C16.7802 6.31936 16.0033 4.98005 14.9403 3.65376C14.8135 3.49449 14.6185 3.40346 14.4137 3.40346L6.28362 3.40021C6.06906 3.40021 5.9748 3.67001 6.13732 3.80654Z M20.5703 14.1922L20.58 14.1793L20.6155 14.1146C20.6026 14.1372 20.5864 14.1631 20.5703 14.1922Z M11.0361 14.5567C12.2714 15.0833 13.3766 15.5287 14.6899 15.883C17.0207 16.5136 19.2311 15.5709 20.3234 13.4872L21.6432 10.8541C21.939 10.2105 22.3128 9.6156 22.7647 9.07273C21.9715 8.78016 21.3149 8.63064 20.4534 8.63064C18.5518 8.63064 16.7606 9.36205 15.4018 10.6948L13.3831 12.6875C12.6647 13.3929 11.878 14.0203 11.0361 14.5567Z M1.62519 9.74885C1.47889 9.60906 1.23511 9.70983 1.23511 9.91463L1.23834 17.8724C1.23834 18.1 1.34887 18.3112 1.53416 18.4348C3.66663 19.8521 6.15343 20.5998 8.72151 20.5998C11.166 20.5998 13.5488 19.9171 15.6098 18.6266C16.3867 18.139 16.9979 17.7099 17.6512 17.0792C16.6013 17.388 15.4472 17.4075 14.2835 17.0922C9.37815 15.7594 5.20097 13.2044 1.62519 9.74885Z"

const DINGTALK_KNOCKOUT =
  "M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10s10-4.477 10-10S17.523 2 12 2m4.49 9.04l-.006.014c-.42.898-1.516 2.66-1.516 2.66l-.005-.012l-.32.558h1.543l-2.948 3.919l.67-2.666h-1.215l.422-1.763a17 17 0 0 0-1.223.349s-.646.378-1.862-.729c0 0-.82-.722-.344-.902c.202-.077.981-.175 1.595-.257a80 80 0 0 1 1.338-.172s-2.555.039-3.161-.057c-.606-.095-1.375-1.107-1.539-1.996c0 0-.253-.488.545-.257s4.101.9 4.101.9S8.27 9.312 7.983 8.99c-.286-.32-.841-1.754-.769-2.634c0 0 .031-.22.257-.16c0 0 3.176 1.45 5.347 2.245s4.06 1.199 3.816 2.228c-.02.087-.072.216-.144.37"

const WECOM_KNOCKOUT =
  "M12 1c6.075 0 11 4.925 11 11s-4.925 11-11 11S1 18.075 1 12S5.925 1 12 1m3.52 15.49a.35.35 0 0 0-.24.1c-.14.13-.16.34.02.53l.07.07c.44.44.74.99.85 1.57c0 .02.04.23.04.23c.05.19.15.37.29.5c.21.21.51.34.82.34c.3 0 .59-.12.8-.33c.44-.44.44-1.16 0-1.61c-.15-.15-.34-.26-.53-.3l-.15-.03c-.61-.11-1.17-.41-1.62-.86c-.03-.03-.07-.07-.1-.11c-.06-.074-.16-.1-.25-.1M11 4.75c-2.117 0-4.264.77-5.75 2.31C4.111 8.246 3.5 9.72 3.5 11.24c0 1.06.3 2.12.88 3.06c.47.695.993 1.371 1.66 1.89l-.384 1.624a.6.6 0 0 0 .856.673L8.64 17.41c.53.166 1.08.234 1.63.3a8.3 8.3 0 0 0 1.7-.03l.38-.05q.283-.046.564-.112a2.33 2.33 0 0 1-.92-1.605l-.254.037c-.62.067-1.232.03-1.85-.04c-.43-.057-.838-.185-1.25-.31l-1.02.5l.23-.67l-.74-.6c-.513-.401-.917-.934-1.28-1.47c-.4-.65-.61-1.38-.61-2.11c0-1.08.456-2.119 1.26-2.97c1.158-1.198 2.854-1.78 4.5-1.78c1.54 0 3.108.513 4.24 1.58c.365.365.707.75.95 1.21c.177.354.338.722.424 1.107a2.34 2.34 0 0 1 1.811.123c-.075-.716-.33-1.4-.665-2.04c-.329-.62-.776-1.155-1.27-1.65c-1.468-1.38-3.471-2.08-5.47-2.08m9.37 9.77a1.136 1.136 0 0 0-1.1.86l-.03.15a3.1 3.1 0 0 1-.86 1.63c-.04.03-.07.07-.11.1c-.14.13-.14.35 0 .49c.07.06.17.1.26.1h.01c.07 0 .15-.02.26-.13l.07-.07c.44-.44.99-.74 1.57-.85c.023 0 .227-.04.23-.04c.2-.06.37-.16.5-.3c.44-.44.44-1.17 0-1.61c-.21-.21-.5-.33-.8-.33m-4.21-1.07c-.08 0-.16.03-.27.14l-.07.07c-.44.44-.99.74-1.57.85c-.02 0-.23.04-.23.04c-.2.06-.37.16-.5.3c-.44.44-.44 1.17 0 1.61c.21.21.51.34.82.34c.3 0 .59-.12.8-.33c.15-.16.25-.34.29-.53a.4.4 0 0 0 .03-.16c.11-.61.41-1.18.86-1.63c.03-.03.06-.06.1-.09c.146-.115.13-.36 0-.49a.34.34 0 0 0-.26-.12m1.18-1.97c-.3 0-.59.12-.8.33c-.44.44-.44 1.16 0 1.61c.15.15.34.26.53.3c.054.006.144.029.15.03c.61.12 1.17.41 1.62.86c.03.03.07.07.1.11c.08.08.16.1.25.1c.1 0 .16-.04.23-.11c.12-.13.14-.32-.02-.52l-.08-.08c-.44-.44-.74-.99-.85-1.57c0-.02-.04-.23-.04-.23c-.05-.19-.15-.37-.29-.5c-.21-.21-.5-.33-.8-.33"

/** Full-bleed 24-viewBox glyph, white on a brand-colored disc. */
function PositiveBadge({ brand, color, glyph, className }: BrandIconProps & { brand: string; color: string; glyph: string }) {
  return (
    <svg viewBox="0 0 24 24" data-brand={brand} className={cn("shrink-0", className)} aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill={color} />
      <g transform="translate(12 12) scale(0.62) translate(-12 -12)">
        <path fill="#fff" d={glyph} />
      </g>
    </svg>
  )
}

/** Disc-with-carved-glyph path scaled to r=12, over the white underlay so the
 * mark stays white in dark mode. `scale` = 12 / source disc radius. */
function KnockoutBadge({ brand, color, glyph, scale, className }: BrandIconProps & { brand: string; color: string; glyph: string; scale: number }) {
  return (
    <svg viewBox="0 0 24 24" data-brand={brand} className={cn("shrink-0", className)} aria-hidden="true">
      <circle cx="12" cy="12" r="11.5" fill="#fff" />
      <g transform={`translate(12 12) scale(${scale}) translate(-12 -12)`}>
        <path fill={color} d={glyph} />
      </g>
    </svg>
  )
}

export function WeChatIcon({ className }: BrandIconProps) {
  return <PositiveBadge brand="wechat" color="#07C160" glyph={WECHAT_GLYPH} className={className} />
}

export function WeComIcon({ className }: BrandIconProps) {
  return <KnockoutBadge brand="wecom" color="#0082EF" glyph={WECOM_KNOCKOUT} scale={12 / 11} className={className} />
}

export function DingTalkIcon({ className }: BrandIconProps) {
  return <KnockoutBadge brand="dingtalk" color="#0089FF" glyph={DINGTALK_KNOCKOUT} scale={12 / 10} className={className} />
}

export function FeishuIcon({ className }: BrandIconProps) {
  return <PositiveBadge brand="feishu" color="#3370FF" glyph={FEISHU_GLYPH} className={className} />
}
