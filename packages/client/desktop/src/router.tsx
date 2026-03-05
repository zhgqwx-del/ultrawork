import { createBrowserRouter } from "react-router-dom"
import { RootLayout } from "@/components/layout"
import { HomePage, SessionPage } from "@/pages"

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      {
        path: "/",
        element: <HomePage />,
      },
      {
        path: "/session/:id",
        element: <SessionPage />,
      },
    ],
  },
])
