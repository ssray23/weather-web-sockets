const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// City coordinates for Open-Meteo API
const cityCoordinates = {
    'London': { latitude: 51.5074, longitude: -0.1278 },
    'New York': { latitude: 40.7128, longitude: -74.0060 },
    'Tokyo': { latitude: 35.6762, longitude: 139.6503 }
};

// Cache for weather data
let weatherData = {};

// Function to fetch real weather data from Open-Meteo API
async function fetchWeatherData(city) {
    const coords = cityCoordinates[city];
    if (!coords) {
        console.error(`Coordinates not found for city: ${city}`);
        return null;
    }

    try {
        // Using Open-Meteo API (free, no API key required)
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}&longitude=${coords.longitude}&current=temperature_2m&timezone=auto`;
        
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.current && data.current.temperature_2m !== undefined) {
            const temperature = Math.round(data.current.temperature_2m);
            return {
                city: city,
                temp: temperature,
                timestamp: new Date().toLocaleTimeString()
            };
        }
        
        return null;
    } catch (error) {
        console.error(`Error fetching weather for ${city}:`, error.message);
        return null;
    }
}

// Function to update weather for a specific city
async function updateCityWeather(city) {
    const weatherUpdate = await fetchWeatherData(city);
    if (weatherUpdate) {
        // Only emit if temperature changed
        if (weatherData[city]?.temp !== weatherUpdate.temp) {
            weatherData[city] = weatherUpdate;
            
            // WEB SOCKET MAGIC:
            // Send this update ONLY to people in this city's "room"
            io.to(city).emit('temperature_update', weatherUpdate);
            console.log(`Weather update for ${city}: ${weatherUpdate.temp}°C`);
        }
    }
}

// SOCKET CONNECTION LOGIC
io.on('connection', async (socket) => {
    console.log('A user connected:', socket.id);

    // 1. Listen for the client selecting a city
    socket.on('subscribe_city', async (city) => {
        // Leave all other rooms (cleanup) so they don't get mixed updates
        socket.rooms.forEach((room) => {
            if (room !== socket.id) socket.leave(room);
        });

        // Join the new city room
        socket.join(city);
        console.log(`Socket ${socket.id} joined room: ${city}`);

        // Fetch and send immediate current temp so they don't have to wait
        const weatherUpdate = await fetchWeatherData(city);
        if (weatherUpdate) {
            weatherData[city] = weatherUpdate;
            socket.emit('temperature_update', weatherUpdate);
        } else {
            // Fallback if API fails
            socket.emit('temperature_update', {
                city: city,
                temp: 'N/A',
                timestamp: new Date().toLocaleTimeString()
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

// REAL WEATHER UPDATE LOGIC
// Fetch real weather data every 5 minutes (300000ms)
// Weather doesn't change as frequently as simulated data
setInterval(async () => {
    const cities = Object.keys(cityCoordinates);
    
    console.log('Fetching weather updates for all cities...');
    for (const city of cities) {
        await updateCityWeather(city);
        // Small delay between API calls to be respectful
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}, 300000); // 5 minutes

// Initial fetch on server start
(async () => {
    console.log('Fetching initial weather data...');
    const cities = Object.keys(cityCoordinates);
    for (const city of cities) {
        await updateCityWeather(city);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
})();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});