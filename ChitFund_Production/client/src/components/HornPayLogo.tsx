export default function HornPayLogo({ size = 48 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      style={{ display: 'block', margin: '0 auto' }}
    >
      <rect width="64" height="64" rx="14" fill="#0F766E" />
      {/* Tail */}
      <path d="M16 44 Q8 50 11 40 Q14 43 16 44Z" fill="white" opacity="0.85" />
      {/* Head */}
      <circle cx="26" cy="38" r="12" fill="white" />
      {/* Beak + Casque */}
      <path d="M36 31 C44 21 54 20 60 33 C58 38 48 43 36 40Z" fill="#F59E0B" />
      {/* Casque-beak groove */}
      <path
        d="M40 31 C47 26 54 26 58 32"
        fill="none"
        stroke="#D97706"
        strokeWidth="1.2"
        opacity="0.6"
      />
      {/* Eye */}
      <circle cx="22" cy="34" r="3" fill="#0D4F47" />
      <circle cx="21" cy="33" r="1.1" fill="white" />
    </svg>
  )
}
