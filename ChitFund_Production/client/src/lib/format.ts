export function formatPaise(paise: number): string {
  const rupees = paise / 100
  return '₹' + rupees.toLocaleString('en-IN')
}

export function formatMobile(mobile: string): string {
  const digits = mobile.replace(/^\+91/, '')
  return digits.replace(/(\d{5})(\d{5})/, '$1 $2')
}

export function initials(name: string): string {
  return name
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}
