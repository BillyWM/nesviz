# Nesviz

Nesviz is a tool for semi-automatically reverse-engineering NES games

Currently an early version. Work in progress

## Current

* Some automatic code discovery on the most common mappers (covering hundreds of games)
	* Automatic handling of bankswitching
* Automatic data discovery, to a lesser extent
* Load CDL files from Mesen for extra code/data coverage
* Trace Streamer
	* Connect to an emulator (BWMesen) for live analysis
	* (WIP. Basic version implemented)
* Memory map
	* Show discovered code and data ranges
	* Show some annotations about what memory is used *for*
* ~~Control-flow Graph~~
	* To be reimplemented

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

* Overhauled analysis engine
	* Enables progressive reporting of analysis progress
	* Generally making the analysis more theoretically correct according to accepted *abstract interpretation* methods
	* Analysis phases and phase groups
	* Analysis log with detailed breakdown while running
	* New in analysis:
		* Detect the "RTS trick"
		* "Excavate" common procedure shapes to jump-start code discovery
* Detect and display banked code
	* Code blocks now show a bank selector when multiple versions are detected across banks
* Removed:
	* Probable code discovery
* Temporarily broken:
	* Control-flow graph (to be re-implemented using neighborhoods)
