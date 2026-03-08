import { useState, useEffect } from "react"

const FAVORITES_KEY = "ultrawork:favorites"

export function useFavorites() {
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(FAVORITES_KEY)
      return stored ? new Set(JSON.parse(stored)) : new Set()
    } catch {
      return new Set()
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]))
    } catch {
      // localStorage full or disabled — silently ignore
    }
  }, [favorites])

  const toggleFavorite = (sessionId: string) => {
    setFavorites((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }

  const isFavorite = (sessionId: string) => favorites.has(sessionId)

  return { favorites, toggleFavorite, isFavorite }
}
