# Explainer narration script

Narration for `evidence/explainer.mp4`. Read by the Windows built-in voice (synthesized speech).

Format, parsed by `tools/video/lib/script.ts`:

- `## N. Title` starts a section.
- `### <clipId> | <kind>:<name>` starts a clip. `kind` is `slide` (a page of `slides.html`, `name` is the slide number), `live` (a recorded browser segment), or `term` (a terminal-style segment showing real command output or real file content).
- The paragraph under a clip heading is the narration for that clip. Numbers are spelled the way they should be spoken.
- The picture for a clip lasts at least as long as its narration. The handoff is split into three live clips so each part of the narration starts on its own picture.

## 1. The problem

### c01 | slide:1

A short walk through a sample system for automating a legacy back-office app: the problem, the design, and a live run.

### c02 | slide:2

Credit unions run back-office software with no A P I. The only way in is the screen. Hundreds of tenants run the same product, configured differently, so a script per tenant does not scale.

### c03 | slide:3

So a model discovers each task once, and what it did is recorded as a typed capability. From then on, the capability replays with no model in the loop, through one seam to the app, the surface.

## 2. The target app

### c04 | live:app-tour

The target is a mock credit union workstation, built to be hostile: a nineties login table, a frameset shell, and a maintenance notice once per session.

### c05 | term:markup

This is its real markup. Labels sit in the next table cell, the search button is a div, result rows have an onclick and no link, and tabs are bare spans. The app can also inject faults on demand.

## 3. Discovery

### c06 | live:observe

In discovery the model sees a screenshot and a flat list of elements, each with a reference, a role, a name, and a frame. It picks one by reference and says what it expects to see next.

### c07 | slide:4

The recorder keeps a fallback chain instead of the reference, from role and name down to a bounding box. Replay reports which one matched. Anything below the first is drift.

### c08 | slide:5

The model's expectation becomes the step's checkpoint, and literal inputs become placeholders.

## 4. The artifact

### c09 | term:artifact

This capability was recorded by a real model run. At the top is the contract: typed inputs and outputs, and a status, approved at version one point two point two. Then nine steps, each with a risk class, most with a locator chain, and three with a checkpoint. Two extend runs added the business outcomes for a missing and a restricted member. Last comes one tenant override, written by hand.

### c10 | term:tenant-drift

Why the override: tenant B labels the field Member number. Without the override, that step still resolved, but through a fallback at depth two. With it, the same replay ran at depth zero.

## 5. Replay

### c11 | slide:6

Replay returns one of four result kinds: success with outputs, a declared business outcome, a hard failure with evidence, or escalated, when a human stepped in.

### c12 | term:replay-success

The real command, for member one two three four five. It returns the name and the savings balance. A recovery rule dismissed the maintenance notice, and every locator matched on its first choice.

### c13 | term:replay-notfound

Member nine nine nine nine nine does not exist, so replay returns the declared outcome, member not found. Exit code three.

### c14 | term:replay-apperror

When the search page fails with a server error, replay stops at step five, calls it an app error, and saves a screenshot and the D O M. Exit code four.

## 6. The handoff

### c15 | slide:7

Some cases need a person. The session broker owns the live browser and a control token. Escalation pauses automation, taking control gives it to a human, and handing back resumes it. Only the holder may act.

### c16 | live:handoff-escalate

Here the session expires mid run. Replay hits the expired page and escalates. Relay, the operator console, queues the case with the screenshot and what automation expected.

### c17 | live:handoff-human

The operator takes control. In the same browser, with the same cookies, they log back in and enter the member number. Relay lists each captured action, without the values.

### c18 | live:handoff-resume

Then they hand back, choosing: I completed this step, continue. Automation picks up at the next step and finishes the lookup.

### c19 | term:handoff-result

The run ends escalated, resolved as resumed success, with the same outputs. The intervention record is in the run directory, and typed values are never stored.

## 7. Architecture and safety

### c20 | slide:8

The code is hexagonal. The core holds the domain and its ports. Adapters below implement them: Playwright for the browser, Anthropic for the model. Above sit the apps: the C L I, which wires it all together, Relay, and the mock app.

### c21 | term:agent-tag

The code inside the page is a standalone plugin, the browser agent: one bundle, two modes. The mock app ships it as a script tag, like a monitoring tag, and when an app does not, the adapter injects it. Each run logs which it found. Here, the app's own copy.

### c22 | term:policy

A policy file sets allowed origins, denied paths, allowed actions, and what marks a control irreversible. The guard wraps the surface, so a denied action never reaches the page.

### c23 | term:redaction

Redaction happens at the log sink. The login user is a bound secret, so it is scrubbed even from the app's own banner text, and the human's typed input is logged with no value.

### c24 | term:no-llm

And a test fails the build if anything under replay imports the model S D K or the discovery agent.

## 8. What was cut

### c25 | slide:9

Left out on purpose: remote co-browsing with operator login, a desktop surface beyond the stub, queues and a database, screenshot redaction, and model-assisted recovery in replay.

### c26 | slide:10

The code, the design notes, and the evidence runs are in the repository. Thanks for watching.
