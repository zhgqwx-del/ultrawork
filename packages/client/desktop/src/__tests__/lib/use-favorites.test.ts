import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useFavorites } from "@/lib/use-favorites"

describe("useFavorites", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("starts with empty set when no storage", () => {
    const { result } = renderHook(() => useFavorites())
    expect(result.current.favorites.size).toBe(0)
  })

  it("restores from localStorage", () => {
    localStorage.setItem("ultrawork:favorites", JSON.stringify(["s1", "s2"]))
    const { result } = renderHook(() => useFavorites())
    expect(result.current.favorites.size).toBe(2)
    expect(result.current.isFavorite("s1")).toBe(true)
    expect(result.current.isFavorite("s2")).toBe(true)
  })

  it("toggleFavorite adds a session", () => {
    const { result } = renderHook(() => useFavorites())

    act(() => {
      result.current.toggleFavorite("s1")
    })

    expect(result.current.isFavorite("s1")).toBe(true)
    expect(result.current.favorites.size).toBe(1)
  })

  it("toggleFavorite removes a favorited session", () => {
    localStorage.setItem("ultrawork:favorites", JSON.stringify(["s1"]))
    const { result } = renderHook(() => useFavorites())

    expect(result.current.isFavorite("s1")).toBe(true)

    act(() => {
      result.current.toggleFavorite("s1")
    })

    expect(result.current.isFavorite("s1")).toBe(false)
    expect(result.current.favorites.size).toBe(0)
  })

  it("isFavorite returns false for non-favorited", () => {
    const { result } = renderHook(() => useFavorites())
    expect(result.current.isFavorite("nonexistent")).toBe(false)
  })

  it("persists to localStorage on change", () => {
    const { result } = renderHook(() => useFavorites())

    act(() => {
      result.current.toggleFavorite("s1")
    })

    const stored = JSON.parse(localStorage.getItem("ultrawork:favorites")!)
    expect(stored).toContain("s1")
  })

  it("handles multiple favorites", () => {
    const { result } = renderHook(() => useFavorites())

    act(() => {
      result.current.toggleFavorite("s1")
    })
    act(() => {
      result.current.toggleFavorite("s2")
    })
    act(() => {
      result.current.toggleFavorite("s3")
    })

    expect(result.current.favorites.size).toBe(3)
    expect(result.current.isFavorite("s1")).toBe(true)
    expect(result.current.isFavorite("s2")).toBe(true)
    expect(result.current.isFavorite("s3")).toBe(true)

    // Remove s2
    act(() => {
      result.current.toggleFavorite("s2")
    })

    expect(result.current.favorites.size).toBe(2)
    expect(result.current.isFavorite("s2")).toBe(false)
  })
})
