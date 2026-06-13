/**
 * Quick way to test the query agent against your local ledger DB without WhatsApp:
 *   npm run ask -- "how much did we spend this month?"
 */
import '../bootstrap.js'; // MUST be first — installs proxy dispatcher before any network call
import { answerQuestion } from '../agents/queryAgent.js';
import { assertConfig } from '../config.js';

async function main() {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    console.error('Usage: npm run ask -- "<your question>"');
    process.exit(1);
  }
  try {
    assertConfig();
  } catch (err) {
    // The query agent only needs the Anthropic key; ignore WhatsApp config gaps.
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY is required.');
      process.exit(1);
    }
  }
  const answer = await answerQuestion(question);
  console.log('\n' + answer + '\n');
}

main();
