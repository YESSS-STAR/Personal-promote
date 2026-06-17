
const username = 'Haniqwafi' ;

const apiKey = 'dfdab2cacbed8da8e78b8d4704064d13' ;

const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${apiKey}&format=json&limit=1`;

async function fetchLiveMusic() {
    const trackNameEl = document.getElementById('track-name');
    const artistNameEl = document.getElementById('artist-name');
    const albumArtEl = document.getElementById('album-art');
    const statusEl = document.getElementById('listening-status');

    try {
        const response = await fetch(url);
        
        // If the network request completely fails, throw an error immediately
        if (!response.ok) {
            throw new Error('Network error');
        }
        
        const data = await response.json();

        // Safely check if Last.fm returned valid track data
        if (data && data.recenttracks && data.recenttracks.track && data.recenttracks.track.length > 0) {
            const track = data.recenttracks.track[0];
            
            // Check if a song is actively playing right this second
            if (track['@attr'] && track['@attr'].nowplaying === 'true') {
                trackNameEl.textContent = track.name;
                
                // Last.fm sometimes structures artist data differently, this safely checks both ways
                artistNameEl.textContent = track.artist['#text'] || track.artist.name || 'Unknown Artist';
                
                // Safely extract the largest available album cover
                let imageUrl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/02/CD_icon_test.svg/150px-CD_icon_test.svg.png';
                if (track.image && track.image.length > 0) {
                    const imgObj = track.image.find(img => img.size === 'extralarge') || track.image[track.image.length - 1];
                    if (imgObj && imgObj['#text']) {
                        imageUrl = imgObj['#text'];
                    }
                }
                albumArtEl.src = imageUrl;
                
                statusEl.textContent = 'Live from AirPods 4';
                statusEl.style.color = '#1DB954'; // Spotify Green
                
                return; // Everything succeeded, stop the function here
            }
        }
        
        // If we reach this line, no errors happened, but no song is currently playing
        setOfflineState(trackNameEl, artistNameEl, albumArtEl, statusEl);

    } catch (error) {
        // If literally ANYTHING crashes above, safely fallback to the offline state
        console.error("Widget Error:", error);
        setOfflineState(trackNameEl, artistNameEl, albumArtEl, statusEl);
    }
}

// A helper function to neatly reset the widget if nothing is playing or an error occurs
function setOfflineState(trackName, artistName, albumArt, status) {
    trackName.textContent = 'Nothing playing';
    artistName.textContent = 'Check back later';
    // Using a reliable generic CD icon so it never shows a broken image link
    albumArt.src = 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/02/CD_icon_test.svg/150px-CD_icon_test.svg.png';
    status.textContent = 'Currently Offline';
    status.style.color = 'var(--ocean-dark)';
}

// Start the sequence
fetchLiveMusic();

// Refresh the data every 15 seconds
setInterval(fetchLiveMusic, 15000);
