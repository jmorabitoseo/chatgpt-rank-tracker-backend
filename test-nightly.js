// test-nightly.js
// Test script to run nightly refresh for specific user/project

require('dotenv').config();
const { testNightlyRefreshNow } = require('./src/nightly');

async function runTest() {
  console.log('🚀 Starting Nightly Refresh Test...');
  console.log('📋 Test Configuration:');
  console.log('   User ID: ccce00a6-07a0-4f37-bf5a-590e6bdcbca4');
  console.log('   Project ID: f6e6beb5-b872-46ae-9560-974e619fdf3d (Hotel test 2)');
  console.log('   Source: Bright Data (Nightly)');
  console.log('   Email Notifications: DISABLED\n');

  try {
    await testNightlyRefreshNow();
    console.log('\n✅ Test completed successfully!');
    console.log('💡 Check your tracking_results table for new entries with source "Bright Data (Nightly)"');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
  
  process.exit(0);
}

runTest(); 