# Nesviz

Nesviz is a tool for semi-automatically reverse-engineering NES games

Currently an early version. Work in progress

Built in Electron - runnable on Windows, Mac, or Linux

## Current

* Some automatic code discovery on a variety of common mappers
* Automatic data discovery, to a lesser extent (WIP)
	* Currently finds pointer-tables and other pointer-like "monotonic" tables
		as well as some other data tables
* "Points of Interest"
	* Automatically marks some common code shapes that are interesting when reversing
* Load CDL files from Mesen for extra code/data coverage
* Trace Streamer
	* Connect to an emulator (BWMesen) for live analysis
	* (WIP. Basic version implemented)
* Memory map
	* Show discovered code and data ranges
	* Show some annotations about what memory is used *for*
* Control-flow Graph

## Planned

* Automatic discovery of level-loading routines, etc
* Enhanced live analysis
	* Needs significant expansion
* Botting
	* To assist live analysis
* Disassembly export
	* Will be able to write:
		* ASM file(s)
		* Formatted exports (Markdown, HTML)
		* "Info-only", bring-your-own-ROM data file with web viewer

## Changes in 0.6

* Detect and display banked code
	* Code blocks now show a bank selector when multiple versions are detected across banks
* Overhauled analysis engine
* Analysis phases and phase groups
* Analysis log with detailed breakdown while running
* New in analysis:
	* Detect the "RTS trick"
	* "Excavate" common procedure shapes to jump-start code discovery
* Remove probable code discovery
* Temporarily broken:
	* Graph view.

## Changes in 0.5

* Code cleanup
	* Remove AI slop like overly-conservative compatibility shims.
* Code discovery
	* Refining "probable code" promotion to reduce false positibves. Getting stricter, requiring things
		like proof through VSA or strong CFG connectedness
	* More clearly show probable code in UI. There turns out to be a lot of mixed blocks, and this should
		help with refining the process
* Show loop points in code block view
* Details in memory map
	* Filling out the memory map with descriptions of how memory is used, and links to the involved functions
* PPU POIs
	* Calling out routines that write palettes or attributes