#!/usr/bin/env python3
"""Generate a sample M3U playlist and matching XMLTV EPG for testing VLC EPG.

Run:  python examples/make_test_epg.py
Outputs examples/test.m3u and examples/test_epg.xml (relative to now).
"""
import datetime, pathlib, sys

HERE = pathlib.Path(__file__).resolve().parent
now = datetime.datetime.now(datetime.timezone.utc)

def fmt(dt):
    return dt.strftime("%Y%m%d%H%M%S") + " +0000"

channels = [
    ("CNN.us@SD", "CNN", "News", "https://stream.example/cnn.m3u8"),
    ("BBC.uk@HD", "BBC One HD", "General", "https://stream.example/bbc.m3u8"),
    ("FOXNZ.us@SD", "Fox News", "News", "https://stream.example/fox.m3u8"),
    ("Eurosport1.de@HD", "Eurosport 1", "Sports", "https://stream.example/eurosport.m3u8"),
    ("TLC.uk@SD", "TLC", "Lifestyle", "https://stream.example/tlc.m3u8"),
]

shows = {
    "CNN.us@SD": [("Breaking News", "News", "Live coverage of the day's top stories."),
                  ("World Report", "News", "International headlines from around the globe."),
                  ("The Situation Room", "News", "Analysis and interviews.")],
    "BBC.uk@HD": [("BBC News at One", "News", "The latest national and international news."),
                  ("Antiques Roadshow", "Entertainment", "Members of the public bring items to be valued."),
                  ("Pointless", "Quiz", "A general knowledge quiz.")],
    "FOXNZ.us@SD": [("Fox & Friends", "News", "Morning news and commentary."),
                    ("The Five", "Talk", "Panel discussion of the day's stories."),
                    ("Special Report", "News", "Evening news broadcast.")],
    "Eurosport1.de@HD": [("Live: Tennis", "Sports", "Wimbledon quarter-final."),
                          ("Highlights", "Sports", "The day's best action."),
                          ("Live: Cycling", "Sports", "Tour stage coverage.")],
    "TLC.uk@SD": [("90 Day Fiancé", "Reality", "Couples navigate visa and cultural challenges."),
                  ("Say Yes to the Dress", "Reality", "Brides choose their wedding gowns."),
                  ("My 600-lb Life", "Docu-series", "Stories of weight loss journeys.")],
}

def main():
    with open(HERE / "test.m3u", "w", encoding="utf-8", newline="\n") as f:
        f.write('#EXTM3U url-tvg="file:///' + (HERE / "test_epg.xml").as_posix() + '"\n')
        for tvg_id, name, group, url in channels:
            f.write(f'#EXTINF:-1 tvg-id="{tvg_id}" tvg-name="{name}" group-title="{group}",{name}\n')
            f.write(url + "\n")

    with open(HERE / "test_epg.xml", "w", encoding="utf-8", newline="\n") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n')
        f.write('<!DOCTYPE tv SYSTEM "xmltv.dtd">\n')
        f.write('<tv generator-info-name="test">\n')
        for tvg_id, name, group, url in channels:
            f.write(f'  <channel id="{tvg_id}"><display-name>{name}</display-name>')
            f.write(f'<icon src="https://picsum.photos/seed/{tvg_id}/400/225"/></channel>\n')
        # 3 programs per channel: one running, two upcoming
        for tvg_id, name, group, url in channels:
            shows_list = shows[tvg_id]
            start = now - datetime.timedelta(minutes=30)
            for i, (title, cat, desc) in enumerate(shows_list):
                stop = start + datetime.timedelta(minutes=60)
                f.write(f'  <programme start="{fmt(start)}" stop="{fmt(stop)}" channel="{tvg_id}">\n')
                if i == 0:
                    f.write(f'    <icon src="https://picsum.photos/seed/{tvg_id}-{i}/400/225"/>\n')
                    f.write(f'    <sub-title lang="en">Episode One</sub-title>\n')
                    f.write(f'    <episode-num system="xmltv_ns">1.2.</episode-num>\n')
                    f.write(f'    <date>2024</date>\n')
                    f.write(f'    <rating system="VCHIP"><value>TV-PG</value></rating>\n')
                    f.write(f'    <credits><director>Jane Doe</director><actor>John Smith</actor><actor>Alice Brown</actor></credits>\n')
                    f.write(f'    <audio><stereo>stereo</stereo><languages>English,Spanish</languages></audio>\n')
                f.write(f'    <title lang="en">{title}</title>\n')
                f.write(f'    <category lang="en">{cat}</category>\n')
                if desc:
                    f.write(f'    <desc lang="en">{desc}</desc>\n')
                f.write('  </programme>\n')
                start = stop
        f.write('</tv>\n')

    print(f"Wrote {HERE / 'test.m3u'} and {HERE / 'test_epg.xml'}")

if __name__ == "__main__":
    sys.exit(main())
