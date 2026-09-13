// 白名单逻辑验证：确认 isAllowed 的 CIDR / 通配 / 精确匹配都正确
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync("lib/server.js", "utf8");

// 从编译产物中抽取 isAllowed + ipInCidr 两个函数，单独执行验证
const start = src.indexOf("function isAllowed");
const end = src.indexOf("\nfunction sendJson");
if (start < 0 || end < 0) {
  console.error("未能在编译产物中定位函数");
  process.exit(1);
}
const code = src.slice(start, end);

const mod = new Function(code + "\nreturn { isAllowed, ipInCidr };")();
const { isAllowed } = mod;

const cases = [
  // [来源IP, 白名单, 期望]
  ["10.233.0.5", ["*"], true],
  ["10.233.0.5", ["0.0.0.0/0"], true],
  ["10.233.0.5", ["10.233.0.0/16"], true],
  ["10.233.99.7", ["10.233.0.0/16"], true],
  ["10.234.0.1", ["10.233.0.0/16"], false],
  ["127.0.0.1", ["127.0.0.1"], true],
  ["::1", ["127.0.0.1"], true], // ::1 归一化为 127.0.0.1
  ["::ffff:10.233.0.5", ["10.233.0.0/16"], true], // IPv4-mapped 归一化
  ["10.233.0.5", ["127.0.0.1", "::1"], false], // 默认白名单拒绝外部
  ["10.233.0.5", ["10.233.0.0/8", "192.168.0.0/16"], true], // 多规则
  ["192.168.1.1", ["10.233.0.0/16"], false],
  ["10.233.0.5", ["10.233.0.0/33"], false], // 非法掩码
  ["10.233.0.5", ["10.233.0.0/abc"], false], // 非法掩码
];

let pass = 0;
let fail = 0;
for (const [ip, list, want] of cases) {
  const got = isAllowed(ip, list);
  const ok = got === want;
  if (ok) pass++;
  else fail++;
  console.log(
    `  ${ok ? "✅" : "❌"} isAllowed(${JSON.stringify(ip)}, ${JSON.stringify(list)}) = ${got}${ok ? "" : ` (期望 ${want})`}`
  );
}

console.log(`\n  通过 ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
