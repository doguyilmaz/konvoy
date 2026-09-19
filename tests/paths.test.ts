import { expect, test } from 'bun:test'
import { dirname, join } from '../src/paths'

test('join builds an absolute path', () => {
  expect(join('/a', 'b', 'c.txt')).toBe('/a/b/c.txt')
})

test('join normalizes dot and dot-dot segments', () => {
  expect(join('/a/b', '..', './c')).toBe('/a/c')
})

test('join keeps a relative path relative', () => {
  expect(join('a', 'b')).toBe('a/b')
})

test('join collapses repeated separators', () => {
  expect(join('/a//b', '/c')).toBe('/a/b/c')
})

test('dirname returns the parent directory', () => {
  expect(dirname('/a/b/c.txt')).toBe('/a/b')
  expect(dirname('/a')).toBe('/')
})
