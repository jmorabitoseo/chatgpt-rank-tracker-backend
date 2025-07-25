# Nightly Refresh Testing Guide

The nightly refresh system now supports environment variable-based testing mode for safer and more flexible testing.

## Environment Variables

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `NIGHTLY_TESTING_MODE` | Enable/disable testing mode | No (defaults to `false`) | `true` or `false` |
| `NIGHTLY_TEST_USER_ID` | Target specific user ID in testing mode | Yes (if testing mode enabled) | `ccce00a6-07a0-4f37-bf5a-590e6bdcbca4` |
| `NIGHTLY_TEST_PROJECT_ID` | Target specific project ID in testing mode | Yes (if testing mode enabled) | `f6e6beb5-b872-46ae-9560-974e619fdf3d` |

## Usage Examples

### Testing Mode (Single User/Project)

```bash
# Using environment variables directly
NIGHTLY_TESTING_MODE=true \
NIGHTLY_TEST_USER_ID=ccce00a6-07a0-4f37-bf5a-590e6bdcbca4 \
NIGHTLY_TEST_PROJECT_ID=f6e6beb5-b872-46ae-9560-974e619fdf3d \

node src/nightly.js

# Or use the test script
node test-nightly.js
```

### Production Mode (All Users)

```bash
# Default behavior - no environment variables needed
node src/nightly.js

# Or explicitly disable testing mode
NIGHTLY_TESTING_MODE=false node src/nightly.js
```

### Using .env file

You can also create a `.env` file in the project root:

```env
NIGHTLY_TESTING_MODE=true
NIGHTLY_TEST_USER_ID=ccce00a6-07a0-4f37-bf5a-590e6bdcbca4
NIGHTLY_TEST_PROJECT_ID=f6e6beb5-b872-46ae-9560-974e619fdf3d
```

Then simply run:
```bash
node src/nightly.js
```

## Test Scripts

### test-nightly.js
A pre-configured test script that sets the environment variables and runs the nightly refresh for the specific test user/project.

```bash
node test-nightly.js
```

### Direct Function Testing
You can also call the test function directly in your code:

```javascript
const { testNightlyRefreshNow } = require('./src/nightly');

// Set environment variables
process.env.NIGHTLY_TESTING_MODE = 'true';
process.env.NIGHTLY_TEST_USER_ID = 'your-user-id';
process.env.NIGHTLY_TEST_PROJECT_ID = 'your-project-id';

// Run test
await testNightlyRefreshNow();
```

## Behavior Differences

### Testing Mode
- Targets only the specified user and project
- Shows detailed logging with "🧪 TESTING MODE" prefix
- Safer for development and testing
- No risk of affecting other users

### Production Mode
- Processes all users with enabled prompts
- Shows "🚀 PRODUCTION MODE" prefix
- Runs the full nightly refresh across all users
- Used for actual production deployments

## Safety Features

- **Validation**: Testing mode validates that both `NIGHTLY_TEST_USER_ID` and `NIGHTLY_TEST_PROJECT_ID` are provided
- **Duplicate Prevention**: Global lock prevents multiple simultaneous runs
- **Error Handling**: Continues processing other users/projects if one fails
- **Logging**: Clear distinction between testing and production modes

## Cron Schedule

The cron job runs at 4:00 AM UTC daily for optimal global timezone coverage:
```javascript
cron.schedule('0 4 * * *', performNightlyRefresh, {
  scheduled: true,
  timezone: "UTC"
});
```

**Global Timezone Impact:**
- **PST/PDT (UTC-8/-7)**: 8:00/9:00 PM previous day (evening)
- **EST/EDT (UTC-5/-4)**: 11:00 PM/12:00 AM previous day (late evening)
- **London (UTC+0/+1)**: 4:00/5:00 AM (early morning)
- **Paris/Berlin (UTC+1/+2)**: 5:00/6:00 AM (early morning)
- **Beijing (UTC+8)**: 12:00 PM (lunch time)
- **Tokyo (UTC+9)**: 1:00 PM (early afternoon)

**Why 4:00 AM UTC is optimal:**
- **Americas**: Runs after business hours when users have finished creating daily prompts
- **Europe**: Runs early morning before users start checking their dashboards
- **Asia**: Runs during lunch/early afternoon as a natural workflow break

This schedule ensures users worldwide get fresh daily data when they need it most.

In production, make sure `NIGHTLY_TESTING_MODE` is not set to `true` to ensure all users are processed. 