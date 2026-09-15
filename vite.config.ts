import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const getGitHubPagesBase = () => {
  const repository = process.env.GITHUB_REPOSITORY
  const owner = process.env.GITHUB_REPOSITORY_OWNER
  const repo = repository?.split('/').at(1)

  if (!repo || !owner) {
    return '/'
  }

  if (repo.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
    return '/'
  }

  return `/${repo}/`
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH || getGitHubPagesBase(),
  plugins: [react()],
})
