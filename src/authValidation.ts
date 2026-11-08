export const accountPasswordRule = '密码至少 8 位，并包含至少 1 个英文字母和 1 个数字。';

export function isValidAccountPassword(value: string) {
  return value.length >= 8 && /[A-Za-z]/.test(value) && /\d/.test(value);
}
