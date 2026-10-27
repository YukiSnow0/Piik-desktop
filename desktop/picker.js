window.capturePicker.sources().then(sources => {
  for (const source of sources) {
    const button = document.createElement('button');
    const image = document.createElement('img');
    image.src = source.thumbnail;
    image.alt = '';
    const name = document.createElement('span');
    name.textContent = source.name;
    button.append(image, name);
    button.addEventListener('click', () => window.capturePicker.select(source.id, document.getElementById('audio').checked));
    document.getElementById('sources').append(button);
  }
});
