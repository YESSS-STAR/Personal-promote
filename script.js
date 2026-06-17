
const username = 'Haniqwafi'; 
const apiKey = 'd0f1d508dea98ba1709f252976b75dac':
const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${apiKey}&format=json&limit=1`;

async function fetchLiveMusic() {
    try {
        const response = await fetch(url);
        const data = await response.json();
        const track = data.recenttracks.track[0];

        const trackNameEl = document.getElementById('track-name');
        const artistNameEl = document.getElementById('artist-name');
        const albumArtEl = document.getElementById('album-art');
        const statusEl = document.getElementById('listening-status');

        // Check if the song is currently playing
        if (track['@attr'] && track['@attr'].nowplaying === 'true') {
            trackNameEl.textContent = track.name;
            artistNameEl.textContent = track.artist['#text'];
            
            // Get the extra-large album image
            const image = track.image.find(img => img.size === 'extralarge');
            albumArtEl.src = image ? image['#text'] : 'https://via.placeholder.com/150';
            
            statusEl.textContent = 'Live from AirPods 4';
            statusEl.style.color = '#1DB954'; // Spotify Green
        } else {
            trackNameEl.textContent = 'Nothing playing';
            artistNameEl.textContent = 'Check back later';
            albumArtEl.src = 'https://via.placeholder.com/150';
            statusEl.textContent = 'Currently Offline';
            statusEl.style.color = 'var(--ocean-dark)';
        }
    } catch (error) {
        console.error('Error fetching music:', error);
        document.getElementById('listening-status').textContent = 'Cannot connect to music';
    }
}

// Run the function immediately when the page loads
fetchLiveMusic();

// Refresh the data every 15 seconds to catch track changes
setInterval(fetchLiveMusic, 15000);
