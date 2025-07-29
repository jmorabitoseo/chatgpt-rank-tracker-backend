// Debug script to test the exact brand detection issue
const { countBrandMatches } = require('./src/utils/analysis');

console.log('🔍 Debugging Brand Detection Issue\n');

// Exact data from user's example
const brandMentions = ["L'Oréal"];
const responseText = `For the best lengthening mascaras, it really comes down to formulas and brushes that help elongate lashes while keeping them separated and defined. Here are some top picks: 1. L'Oréal Paris Telescopic Mascara Why it's great: It has a super slim brush that helps separate and extend even the shortest lashes. Formula: It's a buildable formula that gives that dramatic length without clumping. 2. Maybelline Lash Sensational Lash Multiplying Mascara Why it's great: The curved brush with layered bristles helps grab and lengthen every lash from root to tip. Formula: It's known for adding volume while giving that extra length and lift. 3. Benefit They're Real! Lengthening Mascara Why it's great: It's great for both lengthening and curling. The brush is designed to grab every lash and lengthen them dramatically. Formula: Smudge-proof and long-lasting. 4. Tarte Lights, Camera, Lashes 4-in-1 Mascara Why it's great: This one gives not only length but also volume, curl, and definition. Formula: A mix of natural fibers and conditioning ingredients to help with lash growth too. 5. Too Faced Better Than Sex Mascara Why it's great: It's more volume-focused, but it adds length along with some serious drama. The hourglass brush creates a fanned-out effect. Formula: It's rich and buildable, perfect for long lashes. 6. Lancome Hypnose Drama Instant Full Body Volume Mascara Why it's great: If you're looking for both volume and length, this mascara gives dramatic results without clumps. Formula: It has a smooth, creamy texture that helps lengthen lashes without weighing them down. Do you tend to go for more natural looks, or are you all about dramatic lashes? Some of these have pretty bold effects!`;

console.log('Testing exact user scenario:');
console.log('Brand Mentions:', JSON.stringify(brandMentions));
console.log('Response Text Length:', responseText.length);
console.log('Response Text Preview:', responseText.substring(0, 100) + '...');
console.log();

// Test brand detection
const result = countBrandMatches(brandMentions, responseText);

console.log('Brand Detection Result:');
console.log('- anyMatch:', result.anyMatch);
console.log('- totalMatches:', result.totalMatches);
console.log('- matches:', JSON.stringify(result.matches));
console.log();

// Manual search for verification
const manualSearch = responseText.toLowerCase().includes("l'oréal".toLowerCase());
console.log('Manual search (case insensitive):', manualSearch);

// Check for different quote types
const withStraightQuote = responseText.includes("L'Oréal");
const withCurlyQuote = responseText.includes("L\u2019Oréal");
console.log('Contains L\'Oréal (straight quote):', withStraightQuote);
console.log('Contains L\u2019Oréal (curly quote):', withCurlyQuote);

// Test with different brand formats
console.log('\n--- Testing different brand formats ---');
const testBrands = [
  "L'Oréal",      // straight quote
  "L\u2019Oréal", // curly quote
  "LOreal",       // no apostrophe
  "L Oreal"       // space instead
];

testBrands.forEach(brand => {
  const testResult = countBrandMatches([brand], responseText);
  console.log(`Brand "${brand}": matches=${testResult.totalMatches}, anyMatch=${testResult.anyMatch}`);
});

console.log('\n✅ Debug complete!'); 