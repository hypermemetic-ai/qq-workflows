import { callZgTool } from './search/zg.mjs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const { name, arguments: args } = JSON.parse(input);
  const result = await callZgTool(name, args);
  process.stdout.write(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
