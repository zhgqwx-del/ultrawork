import { createBrowserRouter } from "react-router-dom"
import { HomePage, SessionPage } from "@/pages"

export const router = createBrowserRouter([
  {
    path: "/",
    element: <HomePage />,
  },
  {
    path: "/session/:id",
    element: <SessionPage />,
  },
])
