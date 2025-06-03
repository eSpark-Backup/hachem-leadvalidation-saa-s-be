# Use the official Node.js 22 image
FROM node:22-slim

# Set working directory
WORKDIR /usr/src/app

# Copy dependency files first
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the app
COPY . .

# Expose the port (change 3000 if your app uses a different one)
EXPOSE 3000

# Run the app
CMD ["npm", "run", "dev:full"]
