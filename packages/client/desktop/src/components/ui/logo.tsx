import { useId, type SVGProps } from "react"

/**
 * Ultrawork logo mark — isometric crystal prism.
 * Use `className` to control size, e.g. `<Logo className="size-8" />`
 */
export function Logo(props: SVGProps<SVGSVGElement>) {
  const uid = useId()
  const gt = `${uid}-gt`
  const gl = `${uid}-gl`
  const gr = `${uid}-gr`
  const gref = `${uid}-gref`

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 400 360"
      fill="none"
      {...props}
    >
      <defs>
        <linearGradient id={gt} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#22D3EE" />
          <stop offset="100%" stopColor="#818CF8" />
        </linearGradient>
        <linearGradient id={gl} x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor="#6366F1" />
          <stop offset="100%" stopColor="#4338CA" />
        </linearGradient>
        <linearGradient id={gr} x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor="#4F46E5" />
          <stop offset="100%" stopColor="#3730A3" />
        </linearGradient>
        <linearGradient id={gref} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#06B6D4" />
          <stop offset="50%" stopColor="#A5F3FC" />
          <stop offset="100%" stopColor="#818CF8" />
        </linearGradient>
      </defs>

      {/* Left face */}
      <polygon points="84,100 200,170 200,320 84,250" fill={`url(#${gl})`} />

      {/* Right face */}
      <polygon points="200,170 316,100 316,250 200,320" fill={`url(#${gr})`} />

      {/* Top face */}
      <polygon points="200,30 316,100 200,170 84,100" fill={`url(#${gt})`} />

      {/* Top face refraction */}
      <polygon points="200,30 316,100 200,170" fill="#818CF8" opacity={0.25} />

      {/* Edge highlights */}
      <line x1={200} y1={170} x2={200} y2={320} stroke="#A5B4FC" strokeOpacity={0.2} strokeWidth={1.5} />
      <line x1={200} y1={30} x2={200} y2={170} stroke={`url(#${gref})`} strokeOpacity={0.5} strokeWidth={2} />
      <line x1={200} y1={30} x2={84} y2={100} stroke="#22D3EE" strokeOpacity={0.2} strokeWidth={1} />
      <line x1={200} y1={30} x2={316} y2={100} stroke="#818CF8" strokeOpacity={0.15} strokeWidth={1} />

      {/* Specular highlight */}
      <polygon points="168,73 200,56 224,78 200,90" fill="white" opacity={0.12} />
    </svg>
  )
}
