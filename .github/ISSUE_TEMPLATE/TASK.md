---
name: Task
about: A single implementable unit of work within a Feature
title: "🛠 Task: "
labels: task
assignees: ""
---

# 🛠 Task: {{title}}

---

## Intent

<!-- 👤 PO — Why does this task exist? What user value does it deliver? -->

---

## Functional Description

## <!-- 👤 PO + Designer — What should the system do? Keep it behavior-focused, not implementation-focused. -->

---

## Design Reference

<!-- 👤 Designer — Link the specific Figma frame(s) this task implements -->

- Frame:
- Component spec:

---

## Scope

### In scope

-

### Out of scope

- ***

## Contracts & Interfaces

<!-- 👤 Tech Lead — These are the spec. Implementation must match these exactly. -->

### Request

```json
{}
```

### Response

```json
{}
```

### Events / Side Effects

## <!-- Describe any events emitted, webhooks triggered, or state changes -->

---

## Technical Approach

<!-- 👤 Developer — Filled in during task refinement, before implementation starts -->

- Architecture decisions:
- Data flow:
- Trade-offs:

### Aggregates & Invariants

<!-- Which Aggregates does this task modify? What business rules must hold after the change? -->

- Aggregates:
- Invariants:

---

## Impacted Areas

- Backend:
- Frontend:
- Database:
- APIs:
- External systems:

---

## Gherkin

<!-- 👤 PO + Developer — Written before implementation. Each AC from the parent Feature maps to at least one scenario. -->

```gherkin
Feature: {{feature_name}}

  Scenario: Happy path
    Given
    When
    Then

  Scenario: Edge case
    Given
    When
    Then

  Scenario: Failure case
    Given
    When
    Then
```

---

## Edge Cases & Risks

## <!-- What could go wrong? Reference the edge cases listed in the parent Feature. -->

---

## Observability

<!-- How do we verify this works in production? -->

- Logs:
- Metrics:
- Alerts:

---

## Dependencies

<!-- Prose explanation of why each dependency exists. Issue links are managed natively via gh-issue-dependency — do not add #N references here. -->

---

## Rollout

<!-- Only fill in if applicable -->

- Feature flag:
- Backward compatibility:
- Data migration:

---

## Definition of Done

- [ ] Contracts match implementation
- [ ] All Gherkin scenarios covered by tests
- [ ] Edge cases handled
- [ ] Observability in place
- [ ] Code reviewed
- [ ] Design reviewed (if UI)
- [ ] Documentation updated

---

## Test Mapping

| Gherkin Scenario | Test file | Status |
| ---------------- | --------- | ------ |
|                  |           |        |
