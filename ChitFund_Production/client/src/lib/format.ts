export function formatPaise(paise: number): string {
  const rupees = paise / 100
  return '₹' + rupees.toLocaleString('en-IN')
}

export function initials(name: string): string {
  return name
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}
