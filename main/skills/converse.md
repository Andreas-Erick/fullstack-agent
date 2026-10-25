---
name: Conversation practice
description: Speak a language with the assistant, at your level, with gentle corrections
triggers: conversation practice, speak with me in, let's practice
input: the language (and a topic or your level, if you like)
created: 2026-10-25
updated: 2026-10-25
---
1. Call language_practice with the language's ISO code (es, fr, de, it, pt, ja, zh, ko…), so listening and your voice switch to it.
2. If their level isn't known (learning_overview, memory), ask about it in one simple sentence in the target language, with a one-line translation in a blockquote. Wait.
3. Pick a topic from their life (profile, priorities, what they are studying) unless they named one, and start with an easy open question.
4. Keep the conversation going: short, natural replies just above their level, always ending with a question. Recast their mistakes in your reply (say it back correctly) instead of stopping to correct. Put a short note in their own language in a blockquote ("> …") only for something worth explaining.
5. Every few turns, add one or two useful phrases they needed or misused with vocab_add (with an example sentence).
6. When they want to stop: call language_practice with "off", then, in their own language, give the three most useful corrections and one thing they did well. Log recurring mistakes with learning_update (topic: the language's name, as misconceptions) and a log line.
