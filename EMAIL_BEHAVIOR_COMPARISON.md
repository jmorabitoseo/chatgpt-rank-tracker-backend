# Email Behavior: Before vs After

## 📧 Email Strategy Change

**OLD**: 1 email per JOB  
**NEW**: 1 email per BATCH

---

## 📊 Examples

### Example 1: 5 Prompts

| Scenario | Batches | OLD Emails | NEW Emails |
|----------|---------|------------|------------|
| **Success** | 1 batch of 5 | ✅ 1 email: "Your job completed" | ✅ 1 email: "Batch 1/1 completed - 5 prompts analyzed" |
| **Failure** | 1 batch of 5 | ❌ 1 email: "Your job failed" | ❌ 1 email: "Batch 1/1 failed - 5 prompts could not be processed" |

### Example 2: 10 Prompts

| Scenario | Batches | OLD Emails | NEW Emails |
|----------|---------|------------|------------|
| **Success** | 2 batches of 5 each | ✅ 1 email: "Your job completed" | ✅ 2 emails:<br/>• "Batch 1/2 completed - 5 prompts analyzed"<br/>• "Batch 2/2 completed - 5 prompts analyzed" |
| **Failure** | 2 batches of 5 each | ❌ 1 email: "Your job failed" | ❌ 2 emails:<br/>• "Batch 1/2 failed - 5 prompts could not be processed"<br/>• "Batch 2/2 failed - 5 prompts could not be processed" |

### Example 3: 100 Prompts

| Scenario | Batches | OLD Emails | NEW Emails |
|----------|---------|------------|------------|
| **Success** | 10 batches of 10 each | ✅ 1 email: "Your job completed" | ✅ 10 emails:<br/>• "Batch 1/10 completed - 10 prompts analyzed"<br/>• "Batch 2/10 completed - 10 prompts analyzed"<br/>• ... (8 more) |
| **Failure** | 10 batches of 10 each | ❌ 1 email: "Your job failed" | ❌ 10 emails:<br/>• "Batch 1/10 failed - 10 prompts could not be processed"<br/>• "Batch 2/10 failed - 10 prompts could not be processed"<br/>• ... (8 more) |

---

## 🎯 Key Improvements

### ✅ **Granular Feedback**
- **OLD**: "Your 100 prompts are complete" (vague)
- **NEW**: "Batch 3/10 completed - 10 prompts analyzed" (specific)

### ✅ **Progress Tracking**
- **OLD**: No progress updates, just final notification
- **NEW**: Real-time progress as each batch completes

### ✅ **Specific Prompt Identification**
- **OLD**: No way to know which prompts completed/failed
- **NEW**: Each email lists the exact prompts in that batch

### ✅ **Unique Snapshot IDs**
- **OLD**: Single snapshot_id per job
- **NEW**: Different snapshot_id per batch for identification

### ✅ **Better Error Handling**
- **OLD**: If job fails, you don't know which specific prompts failed
- **NEW**: You know exactly which batch (and prompts) failed

---

## 🔒 Deduplication Protection

### Problem Solved: Retry Duplicates
Previously with failures, Pub/Sub retries would cause multiple emails for the same batch.

### Solution: Snapshot-Based Deduplication
```javascript
// Check if we've already sent an email for this snapshot_id
const { data: existingResults } = await supabase
  .from('tracking_results')
  .select('status')
  .eq('snapshot_id', snapshotID)
  .eq('user_id', prompts[0]?.userId)
  .limit(1);

// Only send email if tracking_results exist (not a retry)
if (existingResults && existingResults.length > 0) {
  // Send email
}
```

---

## 📧 Email Template Variables

### Success Email Template
```json
{
  "appUrl": "https://chatgptranktracker.com",
  "dashboardUrl": "https://chatgptranktracker.com/projects/project-id",
  "snapshotID": "sd_mdbv61kw24ed38a0jf",
  "unsubscribeUrl": "https://chatgptranktracker.com/unsubscribe", 
  "year": 2025,
  "prompts": [
    "best SEO agency in Dallas",
    "top marketing firm in Austin", 
    "leading digital agency in Houston"
  ]
}
```

### Subject Lines
- **Success**: `Batch 3/10 completed - 10 prompts analyzed`
- **Failure**: `Batch 3/10 failed - 10 prompts could not be processed`

---

## 🚀 User Experience Impact

### Better Transparency
Users now know:
- Which specific prompts are in each batch
- Real-time progress updates
- Exact failure points if issues occur
- Unique identifiers (snapshot_ids) for support

### Improved Debugging
If users report issues, you can:
- Identify the exact failing batch by snapshot_id
- See which prompts were affected
- Trace the problem to a specific timeframe
- Provide targeted support

---

## 📈 Email Volume Expectations

| Total Prompts | Batches | Emails (Success) | Emails (Failure) |
|---------------|---------|------------------|------------------|
| 1-4 | 1 | 1 | 1 |
| 5-10 | 1-2 | 1-2 | 1-2 |
| 11-50 | 2-5 | 2-5 | 2-5 |
| 51-100 | 6-10 | 6-10 | 6-10 |
| 101-1000 | 11-100 | 11-100 | 11-100 |

**Note**: Each batch gets exactly 1 email (success OR failure), never both. 