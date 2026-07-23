# Support ticket — FastTest API timestamp format

Send to: FastTest / Assessment Systems support
Ready to paste into email or the support portal.

---

**Subject:** API returns exam timestamps without AM/PM or timezone — results cannot be placed on a timeline

Dear [Support team / Mr. or Ms. Last name],

We integrate with the FastTest REST API (apiVersion 1.2.0, codeVersion 3.82.13) for the UAE assessment programme and sync exam results into our monitoring dashboard. We have identified an issue in the timestamp format returned by the results endpoint that makes exam start times impossible to interpret. Details and evidence below.

## 1. The issue

`GET /tests/registration/{registrationId}/results` returns `startTime` as a bare string with no AM/PM marker and no UTC offset:

```json
"startTime": "2025-10-07 06:58:44"
```

Because there is no AM/PM marker, this value has two possible meanings 12 hours apart, and nothing in the response distinguishes them.

**Concrete example** — registration `NDC428522220`, workspace "Baseline", fetched live on [date]:

| Interpretation | UTC | UAE local (UTC+4) |
|---|---|---|
| 06:58 AM | 06:58 | 10:58 |
| 06:58 PM | 18:58 | 22:58 |

**Question: which one is correct for this registration?**

## 2. This contradicts your own API specification

Your published spec at `https://app.fasttestweb.com/FastTest/api/swagger.json` declares the field as:

```json
"ExamineeRegistrationResult": {
  "properties": {
    "startTime": { "type": "string", "format": "date-time" }
  }
}
```

In OpenAPI/Swagger, `format: date-time` requires RFC 3339 / ISO 8601 (for example `2025-10-07T06:58:44Z`). The value actually returned is not ISO 8601 and carries no offset, so the response does not conform to the documented contract.

## 3. Evidence that the clock is 12-hour, not 24-hour

**3a. Hour range across our full dataset.** Over 71,589 result records spanning 15 August – 7 November 2025:

| Check | Result |
|---|---|
| Records containing an AM/PM marker | 0 |
| Records with hour `00` | 0 |
| Records with hour `13`–`23` | 0 |
| Distinct hours observed | 12 (exactly `01`–`12`) |

A 24-hour clock across three months of testing would produce hours outside this range.

**3b. Timezone shift test — 72 records.** After the timezone setting changed on two of our workspaces, we re-fetched the same registrations and compared each value before and after:

| Reading the values as | Shift observed |
|---|---|
| 24-hour timestamps | Three different shifts: **+5h**, **−7h**, **+17h** |
| A 12-hour clock | A single consistent shift: **+5h** for all 72 |

A timezone change cannot produce three different shifts on the same dataset. The −7h and +17h outliers differ from +5h by exactly ±12 hours, which is the signature of a dropped AM/PM marker.

**3c. Same reading, two different real times.** Two records returned the same hour before the change but behaved differently after it:

| Before | After (+5h) | Date |
|---|---|---|
| `2025-10-21 10:45:24` | `2025-10-21 03:45:24` | unchanged |
| `2025-10-05 10:46:33` | `2025-10-06 03:46:33` | rolled forward one day |

Identical `10:4x` readings, yet the results are 12 hours apart. This is only possible if one value meant 10:45 and the other meant 22:46.

## 4. Related: our four workspaces disagree with each other

For the same registrations, two of our workspaces currently return values five hours apart from the other two:

| Workspace | Timestamps returned |
|---|---|
| English | shifted +5h |
| Baseline | shifted +5h |
| Arabic | not shifted |
| Math | not shifted |

We were advised the platform uses a US timezone and that a change to UTC was being applied. It appears the change reached only two of the four workspaces, so results from different subjects are currently not comparable on a single timeline.

## 5. What we are asking

1. For registration `NDC428522220` with `startTime` `2025-10-07 06:58:44` — was the exam started in the morning or the evening?
2. **What do you recommend as the correct fix?** We would like your guidance on the supported approach before we change anything on our side.
3. Is there an existing option — a request parameter, header, or account setting — that makes the API return a 24-hour clock or a full ISO 8601 value with an offset?
4. Can the timezone setting be aligned across all four of our workspaces, and can you confirm the value each one currently uses?
5. If a fix to the response format is planned, we would appreciate an indication of timing so we can schedule our side accordingly.

For context on impact: exam start times feed our operational monitoring and our exam-integrity checks, including detection of unusually short sittings. Until timestamps can be interpreted, time-based reporting for the programme is unreliable.

We are happy to provide additional registration IDs, captured payloads or a call with your engineering team.

Kind regards,

[Full name]
[Job title]
[Organisation]
[Email] · [Phone]

---

## Notes before sending

- Replace `[date]`, `[Full name]`, `[Job title]`, `[Organisation]`, `[Email]`, `[Phone]`.
- If you have an existing ticket reference, add it as a first line: *"Further to ticket [ref] of [date]…"*
- Section 5 deliberately asks **them** to recommend the fix rather than prescribing one.
- All figures are from live measurements against the production API; they can be reproduced on request.
