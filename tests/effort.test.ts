import { expect, test } from 'bun:test'
import { clampEffort } from '../src/adapters/effort'

test('an unknown capability list passes the request through', () => {
  expect(clampEffort('max')).toEqual({ value: 'max', clamped: false })
})

test('a supported value is used as-is', () => {
  expect(clampEffort('high', ['low', 'medium', 'high', 'xhigh', 'max'])).toEqual({ value: 'high', clamped: false })
})

test('an unsupported value falls to the closest lower rung', () => {
  expect(clampEffort('max', ['low', 'medium', 'high'])).toEqual({ value: 'high', clamped: true })
  expect(clampEffort('high', ['low', 'medium'])).toEqual({ value: 'medium', clamped: true })
})

test('a request below every supported rung takes the lowest', () => {
  expect(clampEffort('low', ['high', 'max'])).toEqual({ value: 'high', clamped: true })
})
