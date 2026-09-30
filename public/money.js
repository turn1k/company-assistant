export const moneyScale = billing => billing?.currency === 'RUB' ? billing.rubPerUSD : 1;
export const moneySymbol = billing => billing?.currency === 'RUB' ? '₽' : '$';
export function formatMoney(value, billing) {
  return (Number(value || 0) * moneyScale(billing)).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + ' ' + moneySymbol(billing);
}
export function budgetDisplay(usd, billing) { return Number((usd * moneyScale(billing)).toFixed(2)); }
export function budgetStored(amount, billing) { return Number((Number(amount) / moneyScale(billing)).toFixed(12)); }
