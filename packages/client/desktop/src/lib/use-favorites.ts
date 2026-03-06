import { useState, useEffect } from "react"

const FAVORITES_KEY = "ultrawork:favorites"

export function useFavorites() {
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    const stored = localStorage.getItem(FAVORITES_KEY)
    return stored ? new Set(JSON.parse(stored)) : new Set()
  })

  useEffect(() => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]))
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
