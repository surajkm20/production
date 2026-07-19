export function formatPaise(paise: number): string {
  const rupees = paise / 100
  return '₹' + rupees.toLocaleString('en-IN')
}

export function formatMobile(mobile: string): string {
  const digits = mobile.replace(/^\+91/, '')
  return digits.replace(/(\d{5})(\d{5})/, '$1 $2')
}

/**
 * Normalises a person's name to Title Case for consistent display regardless of how it was entered.
 *
 * @param name - Raw name string (may be all-caps, all-lowercase, or mixed)
 * @returns The name with each word capitalised, e.g. "john DOE" → "John Doe"
 * @example
 * titleCase('RAMESH kumar') // 'Ramesh Kumar'
 */
export function titleCase(name: string): string {
  return name
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

export function initials(name: string): string {
  return name
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}
