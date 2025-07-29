// Debug script to simulate the exact worker flow
const { countBrandMatches } = require('./src/utils/analysis');

console.log('🔧 Debugging Worker Flow\n');

// Simulate the exact data structure that comes from BrightData
const bres = {
  prompt: "which mascara gives best length?",
  answer_text: `For the best lengthening mascaras, it really comes down to formulas and brushes that help elongate lashes while keeping them separated and defined. Here are some top picks: 1. L'Oréal Paris Telescopic Mascara Why it's great: It has a super slim brush that helps separate and extend even the shortest lashes. Formula: It's a buildable formula that gives that dramatic length without clumping. 2. Maybelline Lash Sensational Lash Multiplying Mascara Why it's great: The curved brush with layered bristles helps grab and lengthen every lash from root to tip. Formula: It's known for adding volume while giving that extra length and lift. 3. Benefit They're Real! Lengthening Mascara Why it's great: It's great for both lengthening and curling. The brush is designed to grab every lash and lengthen them dramatically. Formula: Smudge-proof and long-lasting. 4. Tarte Lights, Camera, Lashes 4-in-1 Mascara Why it's great: This one gives not only length but also volume, curl, and definition. Formula: A mix of natural fibers and conditioning ingredients to help with lash growth too. 5. Too Faced Better Than Sex Mascara Why it's great: It's more volume-focused, but it adds length along with some serious drama. The hourglass brush creates a fanned-out effect. Formula: It's rich and buildable, perfect for long lashes. 6. Lancome Hypnose Drama Instant Full Body Volume Mascara Why it's great: If you're looking for both volume and length, this mascara gives dramatic results without clumps. Formula: It has a smooth, creamy texture that helps lengthen lashes without weighing them down. Do you tend to go for more natural looks, or are you all about dramatic lashes? Some of these have pretty bold effects!`,
  answer_text_markdown: null
};

// Simulate the job data structure from the prompts array
const job = {
  id: "test-prompt-id",
  text: "which mascara gives best length?",
  userId: "test-user-id",
  projectId: "test-project-id",
  brandMentions: ["L'Oréal"], // This is how it should come from server
  domainMentions: ["lorealparisusa.com"],
  userCountry: "US",
  trackingId: "test-tracking-id",
  batchNumber: 0
};

console.log('=== SIMULATING WORKER FLOW ===');
console.log('BrightData Response:');
console.log('- prompt:', bres.prompt);
console.log('- answer_text length:', bres.answer_text.length);
console.log('- answer_text preview:', bres.answer_text.substring(0, 100) + '...');
console.log();

console.log('Job Data:');
console.log('- brandMentions:', JSON.stringify(job.brandMentions));
console.log('- brandMentions type:', typeof job.brandMentions);
console.log('- brandMentions is array:', Array.isArray(job.brandMentions));
console.log();

// Simulate exact worker logic
const answerText = bres.answer_text || bres.answer_text_markdown || '';
console.log('Extracted answerText length:', answerText.length);
console.log();

// Test brand detection with exact same logic as worker
console.log('=== BRAND DETECTION TEST ===');
console.log('Input brandMentions:', JSON.stringify(job.brandMentions));
console.log('Input answerText preview:', answerText.substring(0, 200) + '...');

const match = countBrandMatches(job.brandMentions, answerText);

console.log('countBrandMatches result:', JSON.stringify(match));
console.log();

// Test potential data corruption scenarios
console.log('=== TESTING POTENTIAL ISSUES ===');

// Test if brandMentions might be a string instead of array
const brandAsString = "L'Oréal";
const matchString = countBrandMatches(brandAsString, answerText);
console.log('1. brandMentions as string:', JSON.stringify(matchString));

// Test if brandMentions might be stringified JSON
const brandAsJson = '["L\'Oréal"]';
const matchJson = countBrandMatches(brandAsJson, answerText);
console.log('2. brandMentions as JSON string:', JSON.stringify(matchJson));

// Test if brandMentions might be empty
const brandEmpty = [];
const matchEmpty = countBrandMatches(brandEmpty, answerText);
console.log('3. brandMentions as empty array:', JSON.stringify(matchEmpty));

// Test if answerText might be wrapped in JSON
const answerWrapped = JSON.stringify({answer_text: answerText});
const matchWrapped = countBrandMatches(job.brandMentions, answerWrapped);
console.log('4. answerText wrapped in JSON:', JSON.stringify(matchWrapped));

console.log('\n✅ Worker flow simulation complete!'); 