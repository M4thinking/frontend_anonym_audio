# Build stage: install deps and generate static assets
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Build-time env vars for Vite (override when building the image)
ARG VITE_WS_URL
ARG VITE_ROOM_ID
RUN npm run build

# Runtime stage: serve static site with nginx
FROM nginx:stable-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
