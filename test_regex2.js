const text = "OpenBB Bot:\n10:34 AM - BRENT, US CRUDE FUTURES GAIN OVER 2%, HIGHEST LEVEL SINCE JULY 31\n\n⚡ Sent via Icarus | Arbor Capital — For information and data display only. Trade at your own risk.";
const headerMatch = /^\s*\*{0,2}([a-zA-Z0-9_\s]{1,60}):?\*{0,2}\s*(?:(?:<t:\d+:[a-zA-Z]>|\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*[-—:]\s*)?/im.exec(text);
console.log("headerMatch with optional time:", headerMatch ? headerMatch[0] : "null");

const footerRegex = /(?:_\*\s*)?(?:⚡\s*)?SENT VIA ICARUS[\s\S]*?Trade at your own risk\.?(?:\*_)?/gi;
const strippedFooter = text.replace(footerRegex, '').trim();
console.log("strippedFooter:", strippedFooter);
